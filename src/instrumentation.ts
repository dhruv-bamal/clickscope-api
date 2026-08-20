import { initSentry } from './lib/sentry.js';

/**
 * Must be imported first, before src/app.js, in src/server.ts. Node ESM
 * evaluates a file's static imports in declaration order — each import's
 * full subgraph completes before the next sibling import starts — so
 * this guarantees Sentry.init() runs before anything else in the app
 * (route handlers, the error handler, etc.) has a chance to throw.
 *
 * app.ts itself never imports this module, so supertest-based tests that
 * import `app` directly never trigger Sentry.init() as a side effect.
 */
initSentry();
