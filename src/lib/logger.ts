import pino from 'pino';
import { config } from '../config/index.js';

/**
 * Application-wide structured logger.
 *
 * - development: pretty-printed, colorized, human-readable (via
 *   pino-pretty) — optimized for a developer reading a terminal.
 * - production: newline-delimited JSON on stdout — optimized for a log
 *   aggregator (CloudWatch, Datadog, Loki, etc.) to parse and index.
 *
 * Verbosity is controlled by LOG_LEVEL so it can be tuned per
 * environment without a code change or redeploy.
 */
const options: pino.LoggerOptions = {
  level: config.LOG_LEVEL,
};

// Built conditionally (rather than `transport: isDev ? {...} : undefined`)
// because tsconfig's `exactOptionalPropertyTypes` forbids assigning
// `undefined` to an optional property that isn't explicitly typed to
// accept it — Pino's own types don't, so the key must be omitted
// entirely in production rather than set to `undefined`.
if (config.NODE_ENV === 'development') {
  options.transport = {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:HH:MM:ss',
      ignore: 'pid,hostname',
    },
  };
}

export const logger = pino(options);
