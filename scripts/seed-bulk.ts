import { randomUUID } from 'node:crypto';
import { config } from '../src/config/index.js';
import { pool, query } from '../src/db/pool.js';
import { logger } from '../src/lib/logger.js';
import { hashPassword } from '../src/services/passwordService.js';

/**
 * Bulk, volume-realistic seed for Phase 11's measurement-driven indexing
 * pass. Deliberately separate from scripts/seed.ts, which stays a tiny,
 * deterministic, idempotent dev fixture (3 links, 9 clicks) — this script
 * exists for one purpose only: generate enough data, shaped realistically
 * enough, that an EXPLAIN ANALYZE plan against it tells the truth about
 * what an index would or wouldn't do in production.
 *
 * Run with `npm run seed:bulk`. Never runs against anything but a local
 * database — see assertSafeToRun below.
 */

const BASE_USERS = 500;
const BASE_LINKS = 50_000;
const BASE_CLICKS = 500_000;

/**
 * Shrinks every target proportionally, for a fast run against the test DB
 * (see tests/scripts/seedBulk.test.ts) that still exercises the exact same
 * distribution logic, guard, and ANALYZE call as a full-scale run — just at
 * a scale where "fast enough for npm test" and "produces real data" are
 * both true at once.
 */
const SCALE = Number(process.env.SEED_BULK_SCALE ?? '1');

const TARGET_USERS = Math.max(1, Math.round(BASE_USERS * SCALE));
const TARGET_LINKS = Math.max(TARGET_USERS, Math.round(BASE_LINKS * SCALE));
const TARGET_CLICKS = Math.max(0, Math.round(BASE_CLICKS * SCALE));

const USER_BATCH_SIZE = 500;
const LINK_BATCH_SIZE = 1_000;
const CLICK_BATCH_SIZE = 2_000;

/** Existing-row threshold above which a non---reset run refuses to proceed. */
const ALREADY_SEEDED_THRESHOLD = 1_000;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Two independent checks, not one: NODE_ENV alone isn't a complete
 * guarantee (a misconfigured .env could tag a real Supabase connection as
 * "development"), and hostname alone doesn't need NODE_ENV's help but is
 * checked anyway for defense in depth. This script inserts or truncates
 * hundreds of thousands of rows — the cost of a false negative here (this
 * throwing when it didn't need to) is a rerun; the cost of a false
 * positive (this NOT throwing when it should have) is deleting production
 * data.
 */
/**
 * databaseUrl/nodeEnv are parameters (defaulting to the real config), not a
 * hardcoded read of `config.*` — so tests/scripts/seedBulk.test.ts can
 * exercise both branches of this guard directly, including the
 * refuses-against-a-remote-host case, without needing a real non-local
 * Postgres to test against.
 */
export function assertSafeToRun(
  databaseUrl: string = config.DATABASE_URL,
  nodeEnv: string = config.NODE_ENV,
): void {
  const url = new URL(databaseUrl);
  const isLocalHost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';

  if (nodeEnv === 'production' || !isLocalHost) {
    throw new Error(
      `Refusing to run bulk seed: DATABASE_URL host is "${url.hostname}" (NODE_ENV=${nodeEnv}). ` +
        'This script inserts/truncates hundreds of thousands of rows and is only safe against a local database.',
    );
  }
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick<T>(items: readonly T[]): T {
  return items[randomInt(0, items.length - 1)]!;
}

function shuffle<T>(items: T[]): T[] {
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = randomInt(0, i);
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

/**
 * Splits TARGET_LINKS across TARGET_USERS non-uniformly: 90% of users get a
 * small handful of links (uniform(10,50)), 10% are "power users" with
 * uniform(200,800) — real link ownership isn't flat either, and listLinks'
 * (user_id, created_at DESC, id DESC) index only gets meaningfully exercised
 * (multi-page pagination, a real ORDER BY-driven scan) if at least some
 * users have link counts in the hundreds, not 100 uniform users x 500 each.
 * Counts are generated with this shape, then scaled to hit TARGET_LINKS
 * exactly (rounding drift absorbed by the last user).
 */
function assignLinkCountsPerUser(userCount: number, totalLinks: number): number[] {
  const powerUserCutoff = Math.round(userCount * 0.9);
  const raw: number[] = [];
  let allocated = 0;
  for (let i = 0; i < userCount; i += 1) {
    const count = i >= powerUserCutoff ? randomInt(200, 800) : randomInt(10, 50);
    raw.push(count);
    allocated += count;
  }

  const scaleFactor = totalLinks / allocated;
  const scaled = raw.map((count) => Math.max(1, Math.round(count * scaleFactor)));
  const drift = totalLinks - scaled.reduce((sum, count) => sum + count, 0);
  scaled[scaled.length - 1] = Math.max(1, scaled[scaled.length - 1]! + drift);
  return scaled;
}

/**
 * Zipf-law weights (w_rank = 1/rank^s, normalized by the harmonic sum) —
 * the standard shape for popularity distributions (word frequency, city
 * size, web traffic all fit s≈1). Applied to a shuffled rank order (not
 * insertion order) so the "hottest" links aren't correlated with which
 * user or which position in generation they happen to occupy.
 *
 * Why this matters more than the exact numbers: under UNIFORM click
 * assignment, every link's row-count estimate for `WHERE link_id = $1`
 * would be flat, so there's no case where a Seq Scan on clicks is
 * obviously expensive for one link and cheap for another — skew is what
 * makes the clicks(link_id, clicked_at) index's benefit observable in an
 * EXPLAIN ANALYZE plan at all. See docs/performance/before.md.
 */
function zipfWeights(n: number, exponent = 1.0): number[] {
  const weights = new Array<number>(n);
  let harmonic = 0;
  for (let rank = 1; rank <= n; rank += 1) {
    harmonic += 1 / rank ** exponent;
  }
  for (let rank = 1; rank <= n; rank += 1) {
    weights[rank - 1] = 1 / rank ** exponent / harmonic;
  }
  return weights;
}

/**
 * Per-link click counts via a shuffled Zipf assignment, ±30% jitter so the
 * curve isn't a perfectly deterministic staircase. This is a simplification
 * versus true Poisson sampling around each rank's expectation — acceptable
 * because this script only needs the same *qualitative* shape a real system
 * shows (a few links with thousands of clicks, a long tail near zero), not
 * statistically rigorous per-rank variance.
 */
function assignClickCounts(linkCount: number, totalClicks: number): number[] {
  const weights = zipfWeights(linkCount);
  const rankOrder = shuffle(Array.from({ length: linkCount }, (_, i) => i));

  const counts = new Array<number>(linkCount).fill(0);
  rankOrder.forEach((linkIndex, rankPosition) => {
    const expected = totalClicks * weights[rankPosition]!;
    const jittered = expected * (0.7 + Math.random() * 0.6);
    counts[linkIndex] = Math.max(0, Math.round(jittered));
  });
  return counts;
}

function randomPastDate(maxDaysAgo: number): Date {
  return new Date(Date.now() - randomInt(1, maxDaysAgo) * DAY_MS);
}

interface BatchInsertOptions {
  onConflictDoNothing?: boolean;
}

/**
 * Batched multi-row INSERT, not COPY. COPY is faster for a single flat
 * table with no cross-table bookkeeping, but every row's id here is
 * generated client-side up front specifically so the next table's FK
 * batches (links -> users, clicks -> links) can reference it without a
 * RETURNING-per-row round trip — multi-row INSERT already gets that benefit
 * without a new streaming dependency (pg-copy-streams isn't used anywhere
 * else in this codebase, and CLAUDE.md requires justifying any new
 * dependency, not adding one for a script that only ever runs locally) or
 * CSV-escaping the free-text columns (destination_url, user_agent,
 * referrer). Batch sizes are chosen so rows*columns stays well under
 * Postgres's 65,535-bind-parameter-per-statement ceiling.
 */
async function batchInsert(
  table: string,
  columns: string[],
  rows: unknown[][],
  batchSize: number,
  options: BatchInsertOptions = {},
): Promise<void> {
  const conflictClause = options.onConflictDoNothing ? 'ON CONFLICT DO NOTHING' : '';

  for (let start = 0; start < rows.length; start += batchSize) {
    const chunk = rows.slice(start, start + batchSize);
    const values: unknown[] = [];
    const placeholders = chunk.map((row) => {
      const placeholderGroup = row.map((_, colIndex) => {
        const paramNumber = values.length + colIndex + 1;
        return `$${paramNumber}`;
      });
      values.push(...row);
      return `(${placeholderGroup.join(', ')})`;
    });

    await query(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${placeholders.join(', ')} ${conflictClause}`,
      values,
    );
  }
}

async function countRows(table: string): Promise<number> {
  const result = await query<{ count: number }>(`SELECT count(*)::int AS count FROM ${table}`);
  return result.rows[0]?.count ?? 0;
}

const REFERRERS = [
  null,
  'https://twitter.com/',
  'https://news.ycombinator.com/',
  'https://www.reddit.com/',
  'https://www.google.com/',
  'https://www.facebook.com/',
];
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
  'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36',
];
const COUNTRIES = [null, 'US', 'GB', 'DE', 'IN', 'BR', 'CA', 'AU'];

export interface MainOptions {
  /** Defaults to reading `--reset` off process.argv — overridable so tests/scripts/seedBulk.test.ts can call main() directly without faking argv. */
  reset?: boolean;
}

export async function main(options: MainOptions = {}): Promise<void> {
  assertSafeToRun();

  const reset = options.reset ?? process.argv.includes('--reset');
  const existingLinks = await countRows('links');

  if (existingLinks > ALREADY_SEEDED_THRESHOLD && !reset) {
    throw new Error(
      `links already has ${existingLinks} rows (> ${ALREADY_SEEDED_THRESHOLD}) — looks already ` +
        'bulk-seeded. Pass --reset to truncate and reseed, or this refusal is a safety check ' +
        'against accidentally doubling a large dataset.',
    );
  }

  if (reset) {
    assertSafeToRun(); // re-checked immediately before the destructive statement itself
    await query('TRUNCATE TABLE clicks, links, users CASCADE');
    logger.info('Truncated clicks, links, users before reseeding (--reset)');
  }

  logger.info(
    { TARGET_USERS, TARGET_LINKS, TARGET_CLICKS, SCALE },
    'Starting bulk seed',
  );

  // ---- users ----------------------------------------------------------
  // A single fixed, non-bcrypt string, exactly like scripts/seed.ts's
  // dev fixture — this dataset never exercises login for these accounts,
  // so there's nothing to gain from a real per-user hash beyond burning
  // CPU 500 times for no observable difference.
  const FAKE_USER_PASSWORD_HASH = 'fake-hash-not-a-real-bcrypt-value-bulk-seed';

  const userIds = Array.from({ length: TARGET_USERS }, () => randomUUID());
  const userRows = userIds.map((id, i) => [
    id,
    `bulk-user-${i}@example.com`,
    FAKE_USER_PASSWORD_HASH,
    null,
    null,
  ]);
  await batchInsert(
    'users',
    ['id', 'email', 'password_hash', 'oauth_provider', 'oauth_id'],
    userRows,
    USER_BATCH_SIZE,
  );
  logger.info({ inserted: userRows.length }, 'Seeded users');

  // ---- links ------------------------------------------------------------
  // One real bcrypt hash, computed once and reused for every
  // password-protected link — see the module doc comment for why hashing
  // per-row would cost minutes for no benefit this dataset needs.
  const FIXED_LINK_PASSWORD_HASH = await hashPassword('bulk-seed-fixed-link-password');

  const linksPerUser = assignLinkCountsPerUser(TARGET_USERS, TARGET_LINKS);
  const linkUserIds: string[] = [];
  linksPerUser.forEach((count, userIndex) => {
    for (let i = 0; i < count; i += 1) {
      linkUserIds.push(userIds[userIndex]!);
    }
  });
  // assignLinkCountsPerUser's rounding can land one off TARGET_LINKS in
  // either direction; trim or pad against the actual per-user allocation
  // rather than letting linkUserIds.length silently drift from TARGET_LINKS.
  while (linkUserIds.length > TARGET_LINKS) linkUserIds.pop();
  while (linkUserIds.length < TARGET_LINKS) linkUserIds.push(userIds[userIds.length - 1]!);

  const linkIds = Array.from({ length: TARGET_LINKS }, () => randomUUID());
  const clickCounts = assignClickCounts(TARGET_LINKS, TARGET_CLICKS);

  interface LinkPlan {
    id: string;
    userId: string;
    shortCode: string;
    destinationUrl: string;
    passwordHash: string | null;
    expiresAt: Date | null;
    maxClicks: number | null;
    isActive: boolean;
    clickCount: number;
    createdAt: Date;
  }

  const linkPlans: LinkPlan[] = linkIds.map((id, i) => {
    const clickCount = clickCounts[i]!;
    const roll = Math.random();

    let expiresAt: Date | null = null;
    let isActive = true;
    if (roll < 0.03) {
      // Expired but still active — the exact pre-sweep row shape
      // sweepExpiredLinks' partial index targets.
      expiresAt = randomPastDate(90);
      isActive = true;
    } else if (roll < 0.08) {
      // Expired and already swept — post-sweep debris, proves the
      // partial index correctly excludes rows once is_active flips.
      expiresAt = randomPastDate(90);
      isActive = false;
    }

    let maxClicks: number | null = null;
    if (Math.random() < 0.08) {
      const canBeExhausted = clickCount >= 2;
      const exhausted = canBeExhausted && Math.random() < 0.5;
      maxClicks = exhausted
        ? Math.max(1, Math.floor(clickCount * 0.5))
        : clickCount + randomInt(1, 20);
    }

    return {
      id,
      userId: linkUserIds[i]!,
      shortCode: `bulk-${i.toString(36)}`,
      destinationUrl: `https://example.com/bulk/${i}`,
      passwordHash: Math.random() < 0.05 ? FIXED_LINK_PASSWORD_HASH : null,
      expiresAt,
      maxClicks,
      isActive,
      clickCount,
      createdAt: randomPastDate(365),
    };
  });

  const linkRows = linkPlans.map((link) => [
    link.id,
    link.userId,
    link.shortCode,
    link.destinationUrl,
    link.passwordHash,
    link.expiresAt,
    link.maxClicks,
    link.clickCount,
    link.isActive,
    link.createdAt,
  ]);
  await batchInsert(
    'links',
    [
      'id',
      'user_id',
      'short_code',
      'destination_url',
      'password_hash',
      'expires_at',
      'max_clicks',
      'click_count',
      'is_active',
      'created_at',
    ],
    linkRows,
    LINK_BATCH_SIZE,
    { onConflictDoNothing: true },
  );
  logger.info({ inserted: linkRows.length }, 'Seeded links');

  // ---- clicks -------------------------------------------------------
  // Spread over the last 180 days (not clustered at seed time) so
  // date_trunc('day', clicked_at) grouping in getLinkClickStats has real
  // multi-day buckets, and the >= $3 range filter genuinely excludes rows.
  const CLICK_WINDOW_DAYS = 180;

  const clickRows: unknown[][] = [];
  linkPlans.forEach((link) => {
    for (let c = 0; c < link.clickCount; c += 1) {
      clickRows.push([
        randomUUID(),
        link.id,
        randomUUID(),
        new Date(Date.now() - randomInt(0, CLICK_WINDOW_DAYS) * DAY_MS - randomInt(0, DAY_MS)),
        pick(REFERRERS),
        pick(USER_AGENTS),
        pick(COUNTRIES),
      ]);
    }
  });

  await batchInsert(
    'clicks',
    ['id', 'link_id', 'job_id', 'clicked_at', 'referrer', 'user_agent', 'country'],
    clickRows,
    CLICK_BATCH_SIZE,
  );
  logger.info({ inserted: clickRows.length }, 'Seeded clicks');

  const maxClickCount = Math.max(...clickCounts);
  const avgClickCount = clickCounts.reduce((sum, c) => sum + c, 0) / clickCounts.length;
  logger.info(
    { maxClickCount, avgClickCount: Math.round(avgClickCount * 100) / 100 },
    'Click distribution shape (max should be well above average — that is the intended skew)',
  );

  // Mandatory: the planner's index-vs-seq-scan choices are driven by table
  // statistics (row counts, most-common-values, correlation) that only
  // autovacuum or an explicit ANALYZE refresh — skipping this would leave
  // the planner working off pre-load (near-empty-table) statistics until
  // autovacuum happens to run on its own schedule, making every EXPLAIN
  // plan captured right after this script finishes unreproducible.
  await query('ANALYZE users, links, clicks');
  logger.info('ANALYZE complete');

  const finalCounts = {
    users: await countRows('users'),
    links: await countRows('links'),
    clicks: await countRows('clicks'),
  };
  logger.info(finalCounts, 'Bulk seed complete');
}

// Only auto-run when executed directly (`npm run seed:bulk`) — guarded so
// tests/scripts/seedBulk.test.ts can import main()/assertSafeToRun without
// triggering a real run (and a real pool.end()) as a side effect of import.
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .catch((err: unknown) => {
      logger.error({ err }, 'Bulk seed script failed');
      process.exitCode = 1;
    })
    .finally(() => {
      void pool.end();
    });
}
