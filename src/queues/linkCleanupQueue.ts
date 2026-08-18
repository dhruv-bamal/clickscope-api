import { Queue } from 'bullmq';
import { LINK_CLEANUP_QUEUE_NAME } from './contracts.js';
import { queueConnection } from './connection.js';

/**
 * A separate `Queue` from clickQueue, not a second job type on it — the
 * cleanup sweep runs on a schedule (one job per interval), not once per
 * click, so it has a completely different volume and retention profile.
 * Keeping it distinct also keeps queue-depth metrics for the two queues
 * independently legible (a growing click-queue depth and a growing
 * cleanup-queue depth mean very different things — see Notes.md, "Phase 9:
 * Background Jobs").
 *
 * The repeatable schedule itself is registered from the worker at boot
 * (worker/scheduler.ts), not here — this file's job is just to give the
 * API process (and any future read-only tooling) a handle onto the same
 * queue by name. Retention is modest: cleanup runs are infrequent, so a
 * small fixed history is plenty for debugging.
 */
export const linkCleanupQueue = new Queue(LINK_CLEANUP_QUEUE_NAME, {
  connection: queueConnection,
  defaultJobOptions: {
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 100 },
  },
});
