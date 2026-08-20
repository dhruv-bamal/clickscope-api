import { checkDatabaseHealth } from '../db/health.js';
import { logger } from '../lib/logger.js';
import { checkRedisHealth } from '../lib/redis.js';
import { clickQueue } from '../queues/clickQueue.js';

interface DependencyStatus {
  status: 'ok' | 'error';
  latencyMs: number;
}

/**
 * Distinct from DependencyStatus (not a forced generalization of it):
 * queue depth carries a count a boolean-based check has no room for, and
 * has a third state ('degraded') a simple up/down dependency doesn't. A
 * small amount of duplicated timing boilerplate between this and
 * `timed()` below is the deliberate trade-off, in exchange for not
 * bending a two-call-site helper into a three-shape one.
 */
interface QueueDepthStatus {
  status: 'ok' | 'degraded' | 'error';
  latencyMs: number;
  waiting: number;
}

export interface HealthReport {
  status: 'ok' | 'degraded';
  checks: {
    database: DependencyStatus;
    redis: DependencyStatus;
    queue: QueueDepthStatus;
  };
}

async function timed(check: () => Promise<boolean>): Promise<DependencyStatus> {
  const start = process.hrtime.bigint();
  const ok = await check();
  const latencyMs = Math.round(Number(process.hrtime.bigint() - start) / 1e6);
  return { status: ok ? 'ok' : 'error', latencyMs };
}

/**
 * How many waiting click-recording jobs constitute "degraded," not just
 * "nonzero." A queue is supposed to have some waiting jobs in normal
 * operation — the signal worth surfacing here is a backlog large enough
 * to suggest the worker is falling behind (see worker/index.ts's own
 * logQueueDepth, and Notes.md "Phase 14a" for the operational read on
 * this), not the mere existence of one.
 */
const QUEUE_DEPTH_DEGRADED_THRESHOLD = 100;

/**
 * Checks the click-recording queue specifically, not link-cleanup — see
 * Notes.md "Phase 14a: Observability & API Documentation" / "Why
 * Click-Recording, Not Link-Cleanup" for why. Reuses the API process's
 * own `clickQueue` handle (src/queues/clickQueue.ts): a BullMQ Queue is
 * just a named Redis key namespace, so this reads live state directly
 * from Redis without reaching into the separate worker process at all.
 *
 * Never throws, matching checkDatabaseHealth/checkRedisHealth's
 * contract — a health check that can crash is worse than useless.
 */
async function checkQueueDepth(): Promise<QueueDepthStatus> {
  const start = process.hrtime.bigint();
  try {
    const waiting = await clickQueue.getWaitingCount();
    const latencyMs = Math.round(Number(process.hrtime.bigint() - start) / 1e6);
    return {
      status: waiting > QUEUE_DEPTH_DEGRADED_THRESHOLD ? 'degraded' : 'ok',
      latencyMs,
      waiting,
    };
  } catch (err) {
    logger.error({ err }, 'Queue depth health check failed');
    const latencyMs = Math.round(Number(process.hrtime.bigint() - start) / 1e6);
    return { status: 'error', latencyMs, waiting: -1 };
  }
}

/**
 * Aggregates the readiness of every downstream dependency. Never throws:
 * checkDatabaseHealth, checkRedisHealth, and checkQueueDepth each already
 * catch internally and return a plain status object, so there's nothing
 * here that can reject — a health check that crashes is worse than
 * useless, since it can turn a downstream blip into a full outage of the
 * health endpoint itself.
 */
export async function getHealthReport(): Promise<HealthReport> {
  const [database, redis, queue] = await Promise.all([
    timed(checkDatabaseHealth),
    timed(checkRedisHealth),
    checkQueueDepth(),
  ]);

  const allOk = database.status === 'ok' && redis.status === 'ok' && queue.status === 'ok';

  return {
    status: allOk ? 'ok' : 'degraded',
    checks: { database, redis, queue },
  };
}
