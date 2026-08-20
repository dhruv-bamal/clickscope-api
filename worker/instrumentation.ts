import { initSentry } from './lib/sentry.js';

/**
 * Must be imported first, before any other worker module, in
 * worker/index.ts — same ESM import-ordering reasoning as
 * src/instrumentation.ts.
 */
initSentry();
