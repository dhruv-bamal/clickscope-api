import pino from 'pino';
import { workerConfig } from './config.js';

/**
 * Mirrors src/lib/logger.ts's construction exactly (down to the
 * conditional-`transport` pattern forced by tsconfig's
 * `exactOptionalPropertyTypes`), so worker logs are visually and
 * structurally identical to API logs — pretty-printed in development,
 * newline-delimited JSON in production — just from a different process.
 * See Notes.md, "Phase 9: Background Jobs."
 */
const options: pino.LoggerOptions = {
  level: workerConfig.LOG_LEVEL,
};

if (workerConfig.NODE_ENV === 'development') {
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
