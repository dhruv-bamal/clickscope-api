import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

let query: typeof import('../../src/db/pool.js').query;
let workerQuery: typeof import('../../worker/db/pool.js').query;
let signup: typeof import('../../src/services/authService.js').signup;
let createLink: typeof import('../../src/services/linkService.js').createLink;
let listLinks: typeof import('../../src/services/linkService.js').listLinks;
let getLinkClickStats: typeof import('../../src/services/linkService.js').getLinkClickStats;
let sweepExpiredLinks: typeof import('../../worker/processors/linkCleanupProcessor.js').sweepExpiredLinks;

function uniqueEmail(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

/**
 * pg_stat_user_indexes.idx_scan is a stable, documented cumulative counter
 * — chosen over parsing EXPLAIN's plan output, which is more brittle across
 * Postgres versions and exactly the kind of assertion that silently rots
 * when plan text formatting changes. A delta (not an absolute value) is
 * what's asserted throughout this file, so concurrent noise from other test
 * files sharing this same database doesn't matter — only "did calling the
 * real function increment this specific index's counter" does.
 */
async function idxScanCount(indexName: string): Promise<number> {
  const result = await query<{ idx_scan: string }>(
    'SELECT idx_scan FROM pg_stat_user_indexes WHERE indexrelname = $1',
    [indexName],
  );
  return Number(result.rows[0]?.idx_scan ?? 0);
}

/**
 * Postgres 15+'s shared-memory stats subsystem flushes each backend's
 * pending counters to shared memory at most once per ~1 second (not on
 * every query), and only the backend that actually ran the scan can flush
 * its own pending counters — so a read of pg_stat_user_indexes immediately
 * after the scan that incremented it can genuinely observe the
 * pre-increment value. `pg_stat_force_next_flush()` forces an immediate
 * flush, but only if called on that same backend/connection — node-postgres'
 * Pool reuses its most-recently-released connection first (a LIFO free
 * list), so calling this right after the target function (which released
 * its connection back to the pool a moment earlier) very likely lands on
 * that same connection. Not guaranteed, so a short poll is still kept as a
 * fallback rather than relying on the LIFO assumption alone.
 */
async function waitForIdxScanIncrease(
  indexName: string,
  before: number,
  // sweepExpiredLinks runs on the WORKER's own pool (worker/db/pool.ts),
  // not the API's — a different set of physical connections, so the
  // force-flush call below must run on whichever pool actually executed
  // the scan being checked, or it's a no-op against the wrong backend.
  flushQuery: typeof query = query,
): Promise<number> {
  await flushQuery('SELECT pg_stat_force_next_flush()').catch(() => {
    // Best-effort — a no-op on a connection that isn't the one that ran the
    // scan. The poll loop below is what actually guarantees correctness.
  });

  const deadline = Date.now() + 3000;
  let current = before;
  while (Date.now() < deadline) {
    current = await idxScanCount(indexName);
    if (current > before) return current;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return current;
}

beforeAll(async () => {
  process.loadEnvFile('.env.test');
  ({ query } = await import('../../src/db/pool.js'));
  ({ query: workerQuery } = await import('../../worker/db/pool.js'));
  ({ signup } = await import('../../src/services/authService.js'));
  ({ createLink, listLinks, getLinkClickStats } = await import('../../src/services/linkService.js'));
  ({ sweepExpiredLinks } = await import('../../worker/processors/linkCleanupProcessor.js'));

  // Seeds enough real volume, concentrated under one "noise" owner distinct
  // from every test's own target row(s), that each target WHERE clause
  // below is genuinely selective (a handful of rows out of several
  // thousand) — this is what makes the planner's index choice a robust,
  // scale-driven fact rather than a coin flip on a near-empty test table.
  // Forcing `enable_seqscan = off` was considered and rejected: it's a
  // per-connection session setting, but listLinks/sweepExpiredLinks/
  // getLinkClickStats all draw from the shared pool (up to 10 connections),
  // so there's no reliable way to guarantee it's set on whichever
  // connection actually serves each call without modifying application
  // code purely for testability.
  const { user: noiseUser } = await signup(uniqueEmail('index-usage-noise'), 'a-password');
  const noiseLink = await createLink(noiseUser.id, {
    destinationUrl: 'https://example.com/index-usage-noise-link',
  });

  const NOISE_LINK_COUNT = 3000;
  const noiseLinkRows: unknown[][] = [];
  for (let i = 0; i < NOISE_LINK_COUNT; i += 1) {
    noiseLinkRows.push([randomUUID(), noiseUser.id, `noise-link-${randomUUID()}`, 'https://example.com/n']);
  }
  const linkPlaceholders = noiseLinkRows
    .map((_, i) => `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4})`)
    .join(', ');
  await query(
    `INSERT INTO links (id, user_id, short_code, destination_url) VALUES ${linkPlaceholders}`,
    noiseLinkRows.flat(),
  );

  const NOISE_CLICK_COUNT = 3000;
  const noiseClickRows: unknown[][] = [];
  for (let i = 0; i < NOISE_CLICK_COUNT; i += 1) {
    noiseClickRows.push([noiseLink.id, new Date()]);
  }
  const clickPlaceholders = noiseClickRows.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(', ');
  await query(
    `INSERT INTO clicks (link_id, clicked_at) VALUES ${clickPlaceholders}`,
    noiseClickRows.flat(),
  );

  const NOISE_EXPIRED_INACTIVE_COUNT = 500;
  const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
  for (let i = 0; i < NOISE_EXPIRED_INACTIVE_COUNT; i += 1) {
    // Already-swept noise (is_active=false) — should NOT match the sweep's
    // partial-index predicate, exercising that the partial index correctly
    // excludes rows outside is_active = true.
    await query(
      `INSERT INTO links (id, user_id, short_code, destination_url, expires_at, is_active)
       VALUES ($1, $2, $3, $4, $5, false)`,
      [randomUUID(), noiseUser.id, `noise-inactive-${randomUUID()}`, 'https://example.com/n', pastDate],
    );
  }

  await query('ANALYZE links, clicks');
});

describe('listLinks uses links_user_id_created_at_id_index', () => {
  it('idx_scan increases after calling listLinks for a selective target user', async () => {
    const { user } = await signup(uniqueEmail('index-usage-list'), 'a-password');
    for (let i = 0; i < 20; i += 1) {
      await createLink(user.id, { destinationUrl: `https://example.com/target-${i}` });
    }

    const before = await idxScanCount('links_user_id_created_at_id_index');
    await listLinks(user.id, { limit: 20, offset: 0 });
    const after = await waitForIdxScanIncrease('links_user_id_created_at_id_index', before);

    expect(after).toBeGreaterThan(before);
  });
});

describe('sweepExpiredLinks uses links_expires_at_active_partial_index', () => {
  it('idx_scan increases after calling sweepExpiredLinks with a real matching row', async () => {
    const { user } = await signup(uniqueEmail('index-usage-sweep'), 'a-password');
    const link = await createLink(user.id, { destinationUrl: 'https://example.com/target-expired' });
    await query('UPDATE links SET expires_at = $2 WHERE id = $1', [
      link.id,
      new Date(Date.now() - 60 * 60 * 1000),
    ]);

    const before = await idxScanCount('links_expires_at_active_partial_index');
    const result = await sweepExpiredLinks();
    const after = await waitForIdxScanIncrease(
      'links_expires_at_active_partial_index',
      before,
      workerQuery,
    );

    expect(result.deactivated).toBeGreaterThanOrEqual(1);
    expect(after).toBeGreaterThan(before);
  });
});

describe('getLinkClickStats uses clicks_link_id_clicked_at_index', () => {
  it('idx_scan increases after calling getLinkClickStats for a selective target link', async () => {
    const { user } = await signup(uniqueEmail('index-usage-stats'), 'a-password');
    const link = await createLink(user.id, { destinationUrl: 'https://example.com/target-stats' });
    for (let i = 0; i < 10; i += 1) {
      await query('INSERT INTO clicks (link_id, clicked_at) VALUES ($1, now())', [link.id]);
    }

    const before = await idxScanCount('clicks_link_id_clicked_at_index');
    const stats = await getLinkClickStats(user.id, link.id, new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
    const after = await waitForIdxScanIncrease('clicks_link_id_clicked_at_index', before);

    expect(stats).not.toBeNull();
    expect(after).toBeGreaterThan(before);
  });
});
