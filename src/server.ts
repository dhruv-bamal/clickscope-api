import { app } from './app.js';
import { config } from './config/index.js';
import { pool } from './db/pool.js';
import { logger } from './lib/logger.js';
import { redis } from './lib/redis.js';
import { serviceName } from './lib/serviceInfo.js';

const server = app.listen(config.PORT, () => {
  logger.info(
    { port: config.PORT, env: config.NODE_ENV },
    `${serviceName} listening on port ${config.PORT}`,
  );
});

/**
 * Graceful shutdown.
 *
 * Container orchestrators (Docker, Kubernetes, ECS, etc.) stop a
 * container by sending SIGTERM, then SIGKILL after a grace period if
 * the process hasn't exited. Node's default SIGTERM behavior is to
 * terminate immediately — any in-flight HTTP response gets its
 * connection cut mid-write, and (once this app owns a DB pool, a Redis
 * client, or a BullMQ worker) those connections are abandoned instead
 * of closed cleanly.
 *
 * `server.close()` stops accepting new connections but waits for
 * in-flight requests to finish before its callback fires, so the
 * process only exits once that's actually true. The timeout below is a
 * safety net: if a connection never drains (e.g. a stuck keep-alive
 * socket), we force-exit rather than let the container hang until it's
 * SIGKILLed.
 */
function shutdown(signal: NodeJS.Signals): void {
  logger.info({ signal }, 'Received shutdown signal, closing server gracefully');

  server.close(async (err) => {
    if (err) {
      logger.error({ err }, 'Error while closing server');
      process.exit(1);
    }

    // Both close only after the HTTP server has finished draining
    // in-flight requests, not before or concurrently — those requests may
    // still be awaiting a DB query or a Redis command, and closing either
    // first would break them mid-request instead of letting them
    // complete cleanly.
    await Promise.all([pool.end(), redis.quit()]);

    logger.info('Server closed, exiting');
    process.exit(0);
  });

  setTimeout(() => {
    logger.error('Forced shutdown after timeout — some connections did not close in time');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
