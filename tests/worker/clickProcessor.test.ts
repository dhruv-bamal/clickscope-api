import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ClickJobData } from '../../src/queues/contracts.js';

// worker/processors/clickProcessor.js transitively imports worker/config.js,
// which parses its own (narrower) env schema at import time — same
// dynamic-import-after-loadEnvFile requirement as every file touching
// src/config. Runs against the real clickscope_test database, via the
// worker's own Pool (worker/db/pool.js), not the API's.
let processClickJob: typeof import('../../worker/processors/clickProcessor.js').processClickJob;
let signup: typeof import('../../src/services/authService.js').signup;
let createLink: typeof import('../../src/services/linkService.js').createLink;
let query: typeof import('../../src/db/pool.js').query;

beforeAll(async () => {
  process.loadEnvFile('.env.test');
  ({ processClickJob } = await import('../../worker/processors/clickProcessor.js'));
  ({ signup } = await import('../../src/services/authService.js'));
  ({ createLink } = await import('../../src/services/linkService.js'));
  ({ query } = await import('../../src/db/pool.js'));
});

function uniqueEmail(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

async function createTestLink(label: string): Promise<{ id: string }> {
  const { user } = await signup(uniqueEmail(label), 'a-password');
  return createLink(user.id, { destinationUrl: `https://example.com/${label}` });
}

function clickData(linkId: string, overrides: Partial<ClickJobData> = {}): ClickJobData {
  return {
    clickId: randomUUID(),
    linkId,
    shortCode: 'irrelevant-here',
    referrer: null,
    userAgent: null,
    ...overrides,
  };
}

describe('processClickJob', () => {
  it('inserts a clicks row and increments click_count by 1', async () => {
    const link = await createTestLink('processor-basic');

    await processClickJob(
      clickData(link.id, { referrer: 'https://ref.example.com', userAgent: 'test-agent/1.0' }),
    );

    const clicks = await query<{ referrer: string | null; user_agent: string | null }>(
      'SELECT referrer, user_agent FROM clicks WHERE link_id = $1',
      [link.id],
    );
    expect(clicks.rows).toHaveLength(1);
    expect(clicks.rows[0]?.referrer).toBe('https://ref.example.com');
    expect(clicks.rows[0]?.user_agent).toBe('test-agent/1.0');

    const stored = await query<{ click_count: number }>(
      'SELECT click_count FROM links WHERE id = $1',
      [link.id],
    );
    expect(stored.rows[0]?.click_count).toBe(1);
  });

  it('processing the same job (same clickId) twice is a no-op the second time', async () => {
    // The core idempotency guarantee this phase exists to provide — see
    // Notes.md, "Phase 9: Background Jobs" / "Idempotency." A stalled
    // worker lock, a retry after a lost ack, or a crash mid-job can hand
    // the same job to a second attempt; this proves the second attempt
    // never double-counts.
    const link = await createTestLink('processor-idempotent');
    const data = clickData(link.id);

    await processClickJob(data);
    await processClickJob(data);

    const clicks = await query('SELECT id FROM clicks WHERE link_id = $1', [link.id]);
    expect(clicks.rows).toHaveLength(1);

    const stored = await query<{ click_count: number }>(
      'SELECT click_count FROM links WHERE id = $1',
      [link.id],
    );
    expect(stored.rows[0]?.click_count).toBe(1);
  });

  it('20 concurrently processed jobs with distinct clickIds never lose an increment', async () => {
    // The processing-correctness counterpart to tests/routes/redirect.test.ts's
    // producer-side "20 distinct clickIds" test — this one proves that
    // given 20 already-distinct clickIds, concurrent processing of all 20
    // is race-free, at the layer where the write now actually happens.
    const link = await createTestLink('processor-concurrent');
    const CONCURRENCY = 20;
    const jobs = Array.from({ length: CONCURRENCY }, () => clickData(link.id));

    await Promise.all(jobs.map((job) => processClickJob(job)));

    const stored = await query<{ click_count: number }>(
      'SELECT click_count FROM links WHERE id = $1',
      [link.id],
    );
    expect(stored.rows[0]?.click_count).toBe(CONCURRENCY);

    const clicks = await query('SELECT id FROM clicks WHERE link_id = $1', [link.id]);
    expect(clicks.rows).toHaveLength(CONCURRENCY);
  });
});
