import * as Sentry from '@sentry/node';
import { config } from '../config/index.js';
import { logger } from './logger.js';
import { scrubSentryEvent } from './sentryScrub.js';

export { scrubSentryEvent };

/**
 * Initializes Sentry error tracking for the API process. A no-op (with a
 * log line, not a thrown error) when SENTRY_DSN isn't set — local dev
 * shouldn't require provisioning a Sentry project just to boot, and
 * every Sentry.* call elsewhere in the app is itself a safe no-op when
 * init() was never called.
 *
 * tracesSampleRate: 0 disables performance/transaction instrumentation
 * entirely — this app never calls Sentry.setupExpressErrorHandler or any
 * other Sentry Express middleware, so there is no per-request tracing
 * overhead to disable beyond this. Errors are captured from three
 * existing hook points instead: src/middleware/errorHandler.ts (5xx
 * only), worker/index.ts's job 'failed' listeners, and Sentry's own
 * default uncaughtException/unhandledRejection integrations (enabled
 * automatically by init()). See Notes.md, "Phase 14a: Observability &
 * API Documentation."
 */
export function initSentry(): void {
  if (!config.SENTRY_DSN) {
    logger.info('SENTRY_DSN not set — Sentry error reporting disabled');
    return;
  }

  Sentry.init({
    dsn: config.SENTRY_DSN,
    environment: config.NODE_ENV,
    tracesSampleRate: 0,
    beforeSend: scrubSentryEvent,
  });

  logger.info({ environment: config.NODE_ENV }, 'Sentry error reporting initialized');
}
