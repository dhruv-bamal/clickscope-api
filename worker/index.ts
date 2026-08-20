import './instrumentation.js';

import * as Sentry from '@sentry/node';
import { Queue, Worker } from 'bullmq';
import {
  CLICK_QUEUE_NAME,
  LINK_CLEANUP_QUEUE_NAME,
  type ClickJobData,
} from '../src/queues/contracts.js';
import { workerConfig } from './config.js';
import { pool } from './db/pool.js';
import { logger } from './logger.js';
import { processClickJob } from './processors/clickProcessor.js';
import { sweepExpiredLinks } from './processors/linkCleanupProcessor.js';
import { workerRedis } from './redis.js';
import { registerLinkCleanupScheduler } from './scheduler.js';
import { gracefulShutdown } from './shutdown.js';

/**
 * Worker `concurrency: 5` against this process's own `Pool` `max: 10` (see
 * worker/db/pool.ts) — leaves headroom for the cleanup job's own
 * connection use and any transient retry overlap, and is far more
 * throughput than this project's realistic click volume needs given each
 * job is a cheap two-statement transaction. A starting point, not a tuned
 * number — matches this project's "measure, don't guess" posture from
 * Phase 7/8, revisit against real queue-depth/throughput data rather than
 * adjusting speculatively. See Notes.md, "Phase 9: Background Jobs."
 */
const CLICK_WORKER_CONCURRENCY = 5;

/** How often queue depth is logged — see logQueueDepth below. */
const QUEUE_DEPTH_LOG_INTERVAL_MS = 30_000;

logger.info({ nodeEnv: workerConfig.NODE_ENV }, 'clickscope-worker starting');

/**
 * Read-only Queue handles this process uses for two things neither needs a
 * Worker for: registering the repeatable cleanup schedule
 * (upsertJobScheduler is a Queue method) and periodically logging queue
 * depth. Separate from the API process's own Queue instances in
 * src/queues/ — different process, own connection (workerRedis).
 */
const clickQueueHandle = new Queue<ClickJobData>(CLICK_QUEUE_NAME, { connection: workerRedis });
const cleanupQueueHandle = new Queue(LINK_CLEANUP_QUEUE_NAME, { connection: workerRedis });

const clickWorker = new Worker<ClickJobData>(
  CLICK_QUEUE_NAME,
  async (job) => {
    await processClickJob(job.data);
  },
  { connection: workerRedis, concurrency: CLICK_WORKER_CONCURRENCY },
);

const cleanupWorker = new Worker(
  LINK_CLEANUP_QUEUE_NAME,
  async () => {
    await sweepExpiredLinks();
  },
  { connection: workerRedis, concurrency: 1 },
);

/**
 * Job lifecycle logging, generic across both workers: started (on entering
 * 'active'), completed with duration, failed with attempt number — see
 * Notes.md, "Phase 9: Background Jobs" / "Observability."
 */
for (const [name, worker] of [
  ['click-worker', clickWorker],
  ['cleanup-worker', cleanupWorker],
] as const) {
  const log = logger.child({ worker: name });

  worker.on('active', (job) => {
    log.info({ jobId: job.id, attemptsMade: job.attemptsMade }, 'Job started');
  });

  worker.on('completed', (job) => {
    const durationMs = job.finishedOn && job.processedOn ? job.finishedOn - job.processedOn : null;
    log.info({ jobId: job.id, durationMs }, 'Job completed');
  });

  worker.on('failed', (job, err) => {
    const attemptsMade = job?.attemptsMade ?? null;
    const maxAttempts = job?.opts.attempts ?? null;
    const willRetry =
      job !== undefined &&
      maxAttempts !== null &&
      attemptsMade !== null &&
      attemptsMade < maxAttempts;
    log.error({ jobId: job?.id, err, attemptsMade, maxAttempts, willRetry }, 'Job failed');
    // Safe no-op if Sentry.init() was never called (SENTRY_DSN unset).
    Sentry.captureException(err, { tags: { worker: name, jobId: job?.id ?? 'unknown' } });
  });
}

/**
 * Queue depth as the primary health signal for this process — a growing
 * `waiting`/`delayed` count means the worker is falling behind (concurrency
 * too low, Postgres degraded, or the worker is down entirely), which is
 * exactly the thing that turns click_count's "bounded overshoot" claim
 * from Phase 8 into an honest one rather than a hopeful one once queue lag
 * compounds with cache TTL lag. See Notes.md, "Phase 9: Background Jobs" /
 * "click_count's new worst-case overshoot" and "Observability."
 */
async function logQueueDepth(): Promise<void> {
  const [waiting, active, delayed, failed] = await Promise.all([
    clickQueueHandle.getWaitingCount(),
    clickQueueHandle.getActiveCount(),
    clickQueueHandle.getDelayedCount(),
    clickQueueHandle.getFailedCount(),
  ]);
  logger.info({ queue: CLICK_QUEUE_NAME, waiting, active, delayed, failed }, 'Queue depth');
}

const queueDepthInterval = setInterval(() => {
  logQueueDepth().catch((err: unknown) => logger.error({ err }, 'Failed to log queue depth'));
}, QUEUE_DEPTH_LOG_INTERVAL_MS);
queueDepthInterval.unref();

await registerLinkCleanupScheduler(cleanupQueueHandle);

logger.info({ concurrency: CLICK_WORKER_CONCURRENCY }, 'clickscope-worker ready');

function shutdown(signal: NodeJS.Signals): void {
  logger.info({ signal }, 'Received shutdown signal, closing worker gracefully');
  clearInterval(queueDepthInterval);

  gracefulShutdown([clickWorker, cleanupWorker], [clickQueueHandle, cleanupQueueHandle], pool, [
    workerRedis,
  ])
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      logger.error({ err }, 'Error during worker shutdown');
      process.exit(1);
    });

  setTimeout(() => {
    logger.error('Forced worker shutdown after timeout — a job did not finish in time');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
