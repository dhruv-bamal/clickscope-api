import { Queue } from 'bullmq';
import { CLICK_QUEUE_NAME, type ClickJobData } from './contracts.js';
import { queueConnection } from './connection.js';

/**
 * Default job options for every click-recording job.
 *
 * attempts: 5, backoff: exponential starting at 1s — gives a transient
 * Postgres blip (a restart, a brief pool-exhaustion spike) roughly 30+
 * seconds of retrying (1s, 2s, 4s, 8s, 16s between attempts) before the job
 * is given up on and lands in the failed set for inspection, without
 * retrying indefinitely against a dependency that's genuinely down.
 *
 * removeOnComplete: bounded, not unlimited — this queue processes one job
 * per click, so unbounded completed-job retention is real, unbounded Redis
 * memory growth. Keeping a rolling window of the most recent 5000 is enough
 * to eyeball recent throughput without the queue growing forever.
 *
 * removeOnFail: kept longer/larger than completed (10000, not 5000) —
 * failed jobs are exactly the ones that need to stay inspectable; a job
 * that exhausted its retries is the thing an operator needs to be able to
 * go look at, not something to discard as eagerly as a routine success.
 *
 * See Notes.md, "Phase 9: Background Jobs" for the reasoning behind these
 * numbers, and why a naive list-based queue can't offer any of this at all.
 */
export const clickQueue = new Queue<ClickJobData>(CLICK_QUEUE_NAME, {
  connection: queueConnection,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: { count: 5000 },
    removeOnFail: { count: 10000 },
  },
});

/**
 * Enqueues one click. Deliberately does not catch its own errors — the
 * caller (redirect.ts) decides how to handle an enqueue failure, and for
 * the redirect specifically that means: log it, and redirect anyway. See
 * the "accelerant" framing in Notes.md, "Phase 9: Background Jobs."
 *
 * `jobId: data.clickId` is what makes a duplicate `.add()` call with the
 * same clickId a safe no-op at the BullMQ level, while the job still
 * exists in Redis — the Postgres-side `job_id` unique constraint (see
 * worker/processors/clickProcessor.ts) is the backstop once it doesn't.
 */
export async function enqueueClick(data: ClickJobData): Promise<void> {
  await clickQueue.add('record-click', data, { jobId: data.clickId });
}
