import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from './config/index.js';
import { pool } from './db/pool.js';
import { logger } from './lib/logger.js';

// Read name/version from package.json at runtime rather than hardcoding
// them, so the liveness endpoint can never drift out of sync with the
// package that's actually deployed. Resolved relative to this file (not
// process.cwd()) so it works identically whether run via `tsx
// src/server.ts` in dev or `node dist/server.js` in production.
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const { name: serviceName, version: serviceVersion } = JSON.parse(
  readFileSync(path.join(currentDir, '..', 'package.json'), 'utf-8'),
) as { name: string; version: string };

const app = express();

// Liveness check ONLY — proves the process is running and able to
// respond to HTTP. This is intentionally not the real health endpoint;
// Phase 3 adds one that also checks DB/Redis connectivity. For now this
// gives infra something to point a basic uptime probe at.
app.get('/', (_req, res) => {
  res.json({ name: serviceName, version: serviceVersion });
});

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

    // The pool closes only after the HTTP server has finished draining
    // in-flight requests, not before or concurrently — those requests may
    // still be awaiting a DB query, and closing the pool first would break
    // them mid-request instead of letting them complete cleanly.
    await pool.end();

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
