import { Redis } from 'ioredis';
import { config } from '../config/index.js';
import { logger } from './logger.js';

/**
 * A third dedicated ioredis connection, for exactly one consumer:
 * rate-limit-redis's RedisStore (src/middleware/rateLimit.ts). Following
 * the same rule src/queues/connection.ts documents — one connection per
 * consumer with distinct reliability requirements, never reused — this is
 * neither the shared `redis` client (src/lib/redis.ts) nor `queueConnection`
 * (src/queues/connection.ts).
 *
 * It's built identically to `redis`'s settings, not `queueConnection`'s.
 * BullMQ's `maxRetriesPerRequest: null` requirement (see Notes.md, "Phase
 * 9: Background Jobs" / "The maxRetriesPerRequest conflict") exists
 * because a `Worker` issues blocking commands that must not race
 * ioredis's own retry logic — nothing here does that. This connection's
 * failure mode should look like the cache's instead: bounded retries,
 * fail open, never hang a request indefinitely waiting to find out
 * whether Redis is up.
 *
 * `enableOfflineQueue: false` looks appealing for a fail-open limiter —
 * reject immediately while disconnected instead of queueing — but it's
 * actively wrong paired with `lazyConnect: true` specifically: the very
 * first command ever issued on a lazy connection always arrives before
 * the socket has finished connecting, so with the offline queue disabled
 * that first command *always* fails, even when Redis is perfectly
 * healthy. That first command is rate-limit-redis's Lua-script load,
 * issued synchronously inside `rateLimit()`'s `store.init()` when this
 * module's limiters are constructed — and RedisStore caches that load's
 * result as a single promise it never retries on a non-NOSCRIPT failure,
 * so one failed cold start would silently and permanently neutralize
 * every limiter using this connection for the rest of the process's
 * life, masked by `passOnStoreError`. Leaving the offline queue enabled
 * (ioredis's default) lets that first command simply wait for the
 * connection instead, bounded by `connectTimeout` and
 * `maxRetriesPerRequest` below — the same tradeoff `src/lib/redis.ts`
 * already makes for the cache client, and proven correct there.
 */
export const rateLimitRedisConnection = new Redis(config.REDIS_URL, {
  lazyConnect: true,
  connectTimeout: 5000,
  maxRetriesPerRequest: 1,
});

rateLimitRedisConnection.on('error', (err: Error) => {
  logger.error({ err }, 'Rate-limit Redis connection error');
});
