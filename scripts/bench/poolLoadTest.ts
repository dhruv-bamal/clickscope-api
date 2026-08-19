import { pool, query } from '../../src/db/pool.js';
import { listLinks } from '../../src/services/linkService.js';

/**
 * Throwaway load-test for Phase 11's connection-pool review — not part of
 * the permanent test suite. Fires CONCURRENCY concurrent listLinks() calls
 * (deliberately not getLinkByShortCode: that path is Redis-cached, so it
 * wouldn't exercise the Postgres pool the way this needs to) against
 * distinct real seeded users, sampling pool.waitingCount/idleCount/
 * totalCount every 100ms for the duration of the run. Reports the max
 * waitingCount observed and how long it stayed above zero — the actual
 * undersizing signal — plus a pg_stat_activity state breakdown taken mid-run.
 */
const CONCURRENCY = 500;

async function main(): Promise<void> {
  const usersResult = await query<{ id: string }>('SELECT id FROM users LIMIT $1', [CONCURRENCY]);
  const userIds = usersResult.rows.map((r) => r.id);
  if (userIds.length < CONCURRENCY) {
    throw new Error(`Only ${userIds.length} seeded users available, need ${CONCURRENCY}`);
  }

  const samples: { waiting: number; idle: number; total: number }[] = [];
  let sampling = true;
  // A recursive setImmediate loop, not setInterval: Node's timer resolution
  // can't reliably hit sub-millisecond intervals, and this whole burst
  // completes in well under 100ms, so a 100ms-interval sampler would never
  // fire even once during it (confirmed empirically — see the first run of
  // this script, sampleCount: 0). setImmediate fires once per event-loop
  // tick, which is as fine-grained as this process can actually observe.
  function sampleLoop(): void {
    if (!sampling) return;
    samples.push({ waiting: pool.waitingCount, idle: pool.idleCount, total: pool.totalCount });
    setImmediate(sampleLoop);
  }
  setImmediate(sampleLoop);

  let activitySnapshot: { state: string; count: string }[] = [];
  const activityPromise = query<{ state: string; count: string }>(
    `SELECT coalesce(state, 'none') AS state, count(*)::text AS count
     FROM pg_stat_activity WHERE datname = current_database() GROUP BY state`,
  ).then((r) => {
    activitySnapshot = r.rows;
  });

  const start = process.hrtime.bigint();
  const workPromise = Promise.all(
    userIds.map((userId) => listLinks(userId, { limit: 20, offset: 0 })),
  );
  // Snapshot immediately after dispatch, before any query has had a chance
  // to complete — this is the instant pool.waitingCount peaks, since all
  // 500 acquire() calls are queued synchronously by the .map() above.
  const peakAtDispatch = pool.waitingCount;
  await workPromise;
  await activityPromise;
  const durationMs = Number(process.hrtime.bigint() - start) / 1e6;

  sampling = false;
  samples.push({ waiting: peakAtDispatch, idle: -1, total: -1 });

  const maxWaiting = Math.max(0, ...samples.map((s) => s.waiting));
  const samplesWithWaiting = samples.filter((s) => s.waiting > 0).length;
  const eventLoopTicksAboveZero = samples.filter((s) => s.idle !== -1 && s.waiting > 0).length;

  console.log(
    JSON.stringify(
      {
        concurrency: CONCURRENCY,
        poolMax: 10,
        totalDurationMs: Math.round(durationMs * 100) / 100,
        sampleCount: samples.length,
        peakWaitingCountAtDispatch: peakAtDispatch,
        maxWaitingCountAcrossAllSamples: maxWaiting,
        eventLoopTicksObservedWithWaitingAboveZero: eventLoopTicksAboveZero,
        samplesWithWaitingGtZero: samplesWithWaiting,
        pgStatActivitySnapshot: activitySnapshot,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    void pool.end();
  });
