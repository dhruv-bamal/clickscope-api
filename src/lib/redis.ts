import { Redis } from 'ioredis';
import { config } from '../config/index.js';
import { logger } from './logger.js';

/**
 * Shared Redis client, used for cache-aside link lookups (Phase 8).
 *
 * ioredis is also the library BullMQ's `Queue`/`Worker` classes require
 * (Phase 9's worker/ process and src/queues/) — but this specific client
 * *instance* is never reused for either. Its `maxRetriesPerRequest: 1`
 * setting is incompatible with BullMQ's `Worker`, which throws at
 * construction unless its connection's `maxRetriesPerRequest` is exactly
 * `null`. Even for a `Queue` (which has no such hard requirement), a
 * dedicated connection avoids coupling this client's shutdown/retry
 * semantics to BullMQ's — see src/queues/connection.ts and Notes.md,
 * "Phase 9: Background Jobs" for the full reasoning.
 *
 * `lazyConnect: true` is deliberate and non-default: ioredis normally
 * opens a real TCP connection the moment `new Redis(...)` runs. Without
 * this flag, merely importing this module (which src/app.ts does
 * transitively, via the health route) would open a socket as an
 * import-time side effect — exactly the surprise the app.ts/server.ts
 * split exists to avoid for the Postgres pool (see src/db/pool.ts, which
 * is lazy by default). With it, the connection opens on the first actual
 * command, e.g. the `PING` in checkRedisHealth below.
 */
export const redis = new Redis(config.REDIS_URL, {
  lazyConnect: true,
  connectTimeout: 5000, // mirrors pool.ts's connectionTimeoutMillis
  // Bounds how long a single in-flight command (the health-check ping) can
  // be retried while the connection is down, so a health check fails fast
  // instead of riding out ioredis's default retry budget. This is
  // distinct from `retryStrategy`, which governs background reconnection
  // after a disconnect and is left at its default — reconnecting in the
  // background shouldn't block anything.
  maxRetriesPerRequest: 1,
});

redis.on('error', (err: Error) => {
  logger.error({ err }, 'Redis client error');
});

/**
 * Verifies real Redis connectivity with a PING, not just that the client
 * object exists — mirrors checkDatabaseHealth's contract exactly (never
 * throws, returns a plain boolean) so src/services/health.ts can treat
 * both dependency checks identically.
 */
export async function checkRedisHealth(): Promise<boolean> {
  try {
    await redis.ping();
    return true;
  } catch (err) {
    logger.error({ err }, 'Redis health check failed');
    return false;
  }
}
