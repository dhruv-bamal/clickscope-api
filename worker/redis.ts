import { Redis } from 'ioredis';
import { workerConfig } from './config.js';
import { logger } from './logger.js';

/**
 * The worker's own dedicated ioredis connection, shared by every BullMQ
 * `Worker` instance in this process (the click processor and the cleanup
 * processor). `maxRetriesPerRequest: null` is a hard requirement here —
 * BullMQ's `Worker` throws at construction otherwise, since Worker issues
 * blocking commands that must not race ioredis's own request-retry logic.
 *
 * Sharing this one connection across multiple `Worker` instances *within
 * this process* is explicitly fine per BullMQ's own guidance — the
 * coupling concern that ruled out reusing src/lib/redis.ts's client (see
 * that file's doc comment) was specifically about sharing across the API's
 * HTTP-lifecycle connection and BullMQ's requirements, not about sharing
 * within a single worker process. See Notes.md, "Phase 9: Background
 * Jobs."
 */
export const workerRedis = new Redis(workerConfig.REDIS_URL, {
  maxRetriesPerRequest: null,
  connectTimeout: 5000,
});

workerRedis.on('error', (err: Error) => {
  logger.error({ err }, 'Worker Redis connection error');
});
