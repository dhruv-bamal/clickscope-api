import { beforeAll, describe, expect, it } from 'vitest';

let assertSafeToRun: typeof import('../../scripts/seed-bulk.js').assertSafeToRun;
let main: typeof import('../../scripts/seed-bulk.js').main;
let query: typeof import('../../src/db/pool.js').query;

beforeAll(async () => {
  process.loadEnvFile('.env.test');
  // Shrinks every target ~500x (1 user / ~100 links / ~1,000 clicks) so this
  // runs in CI-friendly time while exercising the exact same distribution
  // logic, guard, and ANALYZE call a full-scale run does. Must be set
  // before the dynamic import below, since seed-bulk.ts computes its
  // TARGET_* constants at module load time.
  process.env.SEED_BULK_SCALE = '0.002';
  ({ assertSafeToRun, main } = await import('../../scripts/seed-bulk.js'));
  ({ query } = await import('../../src/db/pool.js'));
});

describe('assertSafeToRun', () => {
  it('allows a localhost DATABASE_URL in a non-production NODE_ENV', () => {
    expect(() =>
      assertSafeToRun('postgres://user:pass@localhost:5432/clickscope_test', 'development'),
    ).not.toThrow();
  });

  it('allows a 127.0.0.1 DATABASE_URL', () => {
    expect(() =>
      assertSafeToRun('postgres://user:pass@127.0.0.1:5432/clickscope_test', 'test'),
    ).not.toThrow();
  });

  it('refuses a non-local DATABASE_URL host', () => {
    expect(() =>
      assertSafeToRun('postgres://user:pass@prod-db.example.com:5432/clickscope', 'development'),
    ).toThrow(/Refusing to run bulk seed/);
  });

  it('refuses NODE_ENV=production even against a localhost URL', () => {
    expect(() =>
      assertSafeToRun('postgres://user:pass@localhost:5432/clickscope_test', 'production'),
    ).toThrow(/Refusing to run bulk seed/);
  });
});

describe('main (scaled run)', () => {
  it('produces the expected row-count range, a skewed click distribution, and a sweep-target row', async () => {
    await main({ reset: true });

    const counts = await query<{ users: string; links: string; clicks: string }>(
      `SELECT
         (SELECT count(*) FROM users)::text AS users,
         (SELECT count(*) FROM links)::text AS links,
         (SELECT count(*) FROM clicks)::text AS clicks`,
    );
    const row = counts.rows[0]!;
    // SCALE=0.002 targets: 1 user, 100 links, 1,000 clicks. Click count has
    // jitter built in (±30% per link, by design — see scripts/seed-bulk.ts),
    // so it's asserted as a range, not an exact value.
    expect(Number(row.users)).toBe(1);
    expect(Number(row.links)).toBe(100);
    expect(Number(row.clicks)).toBeGreaterThan(500);
    expect(Number(row.clicks)).toBeLessThan(1500);

    const distribution = await query<{ max: number; avg: string }>(
      'SELECT max(click_count) AS max, avg(click_count)::text AS avg FROM links',
    );
    const { max, avg } = distribution.rows[0]!;
    // Shape assertion, not an exact-value one — jitter makes exact per-rank
    // counts nondeterministic by design. The point is confirming the Zipf
    // assignment actually produced skew, not uniform-ish counts.
    expect(max).toBeGreaterThan(10 * Number(avg));

    const sweepTarget = await query<{ count: string }>(
      `SELECT count(*)::text FROM links
       WHERE is_active = true AND expires_at IS NOT NULL AND expires_at <= now()`,
    );
    expect(Number(sweepTarget.rows[0]!.count)).toBeGreaterThan(0);
  });
});
