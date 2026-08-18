import { Redis } from 'ioredis';
import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';

/**
 * A dedicated ioredis connection for this process's BullMQ `Queue`
 * instances — deliberately NOT the shared `redis` client from
 * src/lib/redis.ts. Two reasons, not one:
 *
 * 1. `maxRetriesPerRequest`. The shared client sets `maxRetriesPerRequest:
 *    1` so its health-check PING fails fast. BullMQ's `Worker` class (used
 *    by worker/, not here) throws at construction if its connection's
 *    `maxRetriesPerRequest` isn't exactly `null` — Worker issues blocking
 *    commands that must not race ioredis's own request-retry logic. A
 *    `Queue` (this file) has no such hard requirement, but this connection
 *    is still built with `maxRetriesPerRequest: null` for consistency: one
 *    mental model for "any BullMQ connection," rather than a `Queue`-only
 *    exception someone has to remember later.
 * 2. Shutdown lifecycle. src/server.ts's shutdown() calls `redis.quit()`
 *    unconditionally, with no knowledge that a `Queue` might have commands
 *    in flight. Draining a `Queue` correctly means calling `queue.close()`
 *    before its connection quits — sharing the singleton would force
 *    server.ts to become aware of BullMQ's own shutdown ordering, exactly
 *    the kind of cross-cutting coupling a dedicated connection avoids.
 *
 * See Notes.md, "Phase 9: Background Jobs" for the full writeup.
 */
export const queueConnection = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
  connectTimeout: 5000,
});

queueConnection.on('error', (err: Error) => {
  logger.error({ err }, 'BullMQ queue connection error');
});
