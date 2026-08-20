import { describe, expect, it } from 'vitest';
import { computePercentiles, groupDurationsByRoute } from '../../scripts/log-percentiles.js';

// No dependency on src/config here — log-percentiles.ts only reads
// files/stdin and parses JSON — so no loadEnvFile/dynamic-import dance is
// needed, unlike most other tests in this suite.

describe('computePercentiles', () => {
  it('computes p50/p95/p99 via nearest-rank on a known 1..100 distribution', () => {
    const durations = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100

    const result = computePercentiles(durations);

    expect(result.count).toBe(100);
    // Nearest-rank: floor((p/100) * length), clamped to the last index —
    // matches scripts/bench/clickWriteBench.ts's existing percentile
    // helper. For a 100-length 1..100 array, index p equals value p+1.
    expect(result.p50).toBe(51);
    expect(result.p95).toBe(96);
    expect(result.p99).toBe(100);
  });

  it('returns zeros for an empty input rather than throwing', () => {
    expect(computePercentiles([])).toEqual({ count: 0, p50: 0, p95: 0, p99: 0 });
  });

  it('does not depend on input order', () => {
    const sorted = computePercentiles([10, 20, 30, 40, 50]);
    const shuffled = computePercentiles([40, 10, 50, 20, 30]);

    expect(shuffled).toEqual(sorted);
  });
});

describe('groupDurationsByRoute', () => {
  it('groups "Request completed" lines by "METHOD route", skipping everything else', () => {
    const lines = [
      JSON.stringify({ msg: 'Request completed', method: 'GET', route: '/api/links/:id', durationMs: 12 }),
      JSON.stringify({ msg: 'Request completed', method: 'GET', route: '/api/links/:id', durationMs: 8 }),
      JSON.stringify({ msg: 'Request started', method: 'GET', route: '/api/links/:id' }),
      JSON.stringify({ msg: 'Request completed', method: 'POST', route: '/api/links', durationMs: 20 }),
      'not even json',
      '',
    ];

    const grouped = groupDurationsByRoute(lines);

    expect(grouped.get('GET /api/links/:id')).toEqual([12, 8]);
    expect(grouped.get('POST /api/links')).toEqual([20]);
    expect(grouped.size).toBe(2);
  });

  it('never groups by raw path — a UUID-bearing raw path is not what this function reads', () => {
    // route is what's grouped on; a log line missing `route` (an older
    // log format, or one that only ever recorded raw `path`) is skipped
    // entirely rather than silently grouped by path.
    const lines = [
      JSON.stringify({ msg: 'Request completed', method: 'GET', path: '/api/links/abc-123', durationMs: 5 }),
    ];

    expect(groupDurationsByRoute(lines).size).toBe(0);
  });
});
