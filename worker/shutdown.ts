import type { Queue, Worker } from 'bullmq';
import type { Pool } from 'pg';
import type { Redis } from 'ioredis';
import { logger } from './logger.js';

/**
 * Drains every BullMQ `Worker` — `Worker.close()` (called with no `force`
 * argument, i.e. `force: false`) waits for any currently-active job to
 * finish before resolving, rather than abandoning it mid-processing — then
 * closes the Postgres pool and the shared Redis connection.
 *
 * This is the worker process's analogue to src/server.ts's shutdown(), not
 * a reuse of it: that file calls `app.listen`/`server.close()`, which has
 * no meaning here — there's no HTTP server, no in-flight *requests* to
 * drain, only in-flight *jobs*. The ordering principle is the same one
 * server.ts already documents: nothing that a currently-running unit of
 * work depends on (the DB pool, the Redis connection) closes until that
 * work has actually finished, not before or concurrently with it.
 *
 * Exported standalone, independent of any real SIGTERM/process lifecycle,
 * specifically so it's unit-testable by calling it directly — signal
 * handling itself still needs a real child-process test (see
 * tests/worker/clickQueue.integration.test.ts), but the shutdown logic
 * itself doesn't have to pay that cost to be tested. See Notes.md, "Phase
 * 9: Background Jobs" / "Worker graceful shutdown."
 */
export async function gracefulShutdown(
  workers: readonly Worker[],
  queues: readonly Queue[],
  pool: Pool,
  redisConnections: readonly Redis[],
): Promise<void> {
  logger.info('Closing workers, draining in-flight jobs');
  await Promise.all(workers.map((worker) => worker.close()));

  logger.info('Workers closed, closing queue handles, database pool, and Redis connection(s)');
  await Promise.all(queues.map((queue) => queue.close()));
  await pool.end();
  await Promise.all(redisConnections.map((connection) => connection.quit()));

  logger.info('Worker shutdown complete');
}
