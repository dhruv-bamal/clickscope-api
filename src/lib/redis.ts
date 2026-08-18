import { Redis } from 'ioredis';
import { config } from '../config/index.js';
import { logger } from './logger.js';

/**
 * Shared Redis client. Connection only in this phase — no caching logic,
 * that's Phase 8. BullMQ (the future worker/ process) requires ioredis
 * specifically, so this is also the client that phase will reuse rather
 * than introducing a second Redis library.
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
