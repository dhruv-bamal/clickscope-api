import * as Sentry from '@sentry/node';
import { scrubSentryEvent } from '../../src/lib/sentryScrub.js';
import { workerConfig } from '../config.js';
import { logger } from '../logger.js';

/**
 * Mirrors src/lib/sentry.ts exactly, for the separate worker process.
 * Reuses the same scrubSentryEvent from src/lib/ — the worker already
 * imports across from src/ for contracts.ts and envSchema (see
 * worker/config.ts), so this is an established pattern, not a new one.
 */
export function initSentry(): void {
  if (!workerConfig.SENTRY_DSN) {
    logger.info('SENTRY_DSN not set — Sentry error reporting disabled');
    return;
  }

  Sentry.init({
    dsn: workerConfig.SENTRY_DSN,
    environment: workerConfig.NODE_ENV,
    tracesSampleRate: 0,
    beforeSend: scrubSentryEvent,
  });

  logger.info({ environment: workerConfig.NODE_ENV }, 'Sentry error reporting initialized');
}
