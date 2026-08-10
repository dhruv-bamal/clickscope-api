import { parseEnv, EnvValidationError } from './env.js';
import type { Config } from './env.js';

/**
 * The app's single typed configuration object, validated once at
 * process startup. Every other module imports `config` from here
 * instead of reading process.env directly — that way there is exactly
 * one place where an invalid environment can crash the process, and
 * every other module can trust the values it receives are well-formed.
 *
 * Deliberately uses console.error rather than the Pino logger: the
 * logger's own setup (log level, transport) depends on `config` being
 * valid, so it can't be relied on to report a config failure.
 */
let config: Config;

try {
  config = parseEnv(process.env);
} catch (error) {
  if (error instanceof EnvValidationError) {
    console.error(
      `\n[clickscope-api] Startup failed — invalid configuration.\n\n${error.message}\n`,
    );
  } else {
    console.error('[clickscope-api] Unexpected error while loading configuration:', error);
  }
  process.exit(1);
}

export { config };
export type { Config };
