import { randomUUID } from 'node:crypto';
import { pool, query } from '../../worker/db/pool.js';
import { processClickJob } from '../../worker/processors/clickProcessor.js';

/**
 * Same treatment as scripts/bench/poolLoadTest.ts, for the worker's own
 * pool (worker/db/pool.ts, max: 10, Worker concurrency: 5). A burst of
 * BURST_SIZE concurrent processClickJob calls approximates a spike of
 * enqueued click jobs all landing at once — worse than steady-state
 * concurrency: 5 would ever actually deliver via BullMQ, but that's the
 * point of a burst test: find the ceiling, not the typical case.
 */
const BURST_SIZE = 200;

async function main(): Promise<void> {
  const linkRows = await query<{ id: string }>('SELECT id FROM links LIMIT $1', [BURST_SIZE]);
  const linkIds = linkRows.rows.map((r) => r.id);

  const samples: number[] = [];
  let sampling = true;
  function sampleLoop(): void {
    if (!sampling) return;
    samples.push(pool.waitingCount);
    setImmediate(sampleLoop);
  }
  setImmediate(sampleLoop);

  const activityPromise = query<{ state: string; count: string }>(
    `SELECT coalesce(state, 'none') AS state, count(*)::text AS count
     FROM pg_stat_activity WHERE datname = current_database() GROUP BY state`,
  );

  const start = process.hrtime.bigint();
  const workPromise = Promise.all(
    linkIds.map((linkId) =>
      processClickJob({
        clickId: randomUUID(),
        linkId,
        shortCode: 'bench',
        referrer: null,
        userAgent: null,
      }),
    ),
  );
  const peakAtDispatch = pool.waitingCount;
  await workPromise;
  const activitySnapshot = (await activityPromise).rows;
  const durationMs = Number(process.hrtime.bigint() - start) / 1e6;

  sampling = false;

  console.log(
    JSON.stringify(
      {
        burstSize: BURST_SIZE,
        workerPoolMax: 10,
        workerConcurrencyConfigured: 5,
        totalDurationMs: Math.round(durationMs * 100) / 100,
        sampleCount: samples.length,
        peakWaitingCountAtDispatch: peakAtDispatch,
        maxWaitingCountAcrossAllSamples: Math.max(0, ...samples),
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
