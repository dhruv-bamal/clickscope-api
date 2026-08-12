import { z } from 'zod';

/**
 * Schema for every environment variable the app needs in order to boot.
 * This is the single source of truth for what "valid configuration"
 * means — later phases (auth secrets, OAuth client IDs, etc.) extend it
 * here, not by reaching into process.env ad hoc elsewhere in the app.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  PORT: z.coerce
    .number({ invalid_type_error: 'PORT must be a number' })
    .int('PORT must be an integer')
    .positive('PORT must be a positive number')
    .max(65535, 'PORT must be a valid TCP port (<= 65535)')
    .default(3000),

  DATABASE_URL: z
    .string({
      required_error: 'DATABASE_URL is required, e.g. postgres://user:pass@localhost:5432/db',
    })
    .url(
      'DATABASE_URL must be a valid connection string, e.g. postgres://user:pass@localhost:5432/db',
    ),

  REDIS_URL: z
    .string({ required_error: 'REDIS_URL is required, e.g. redis://localhost:6379' })
    .url('REDIS_URL must be a valid connection string, e.g. redis://localhost:6379'),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  // Comma-separated list of origins allowed to make cross-origin requests
  // (e.g. the Next.js frontend in dev, plus a deployed preview URL).
  // Required with no default, and explicitly forbidden from being "*" —
  // an API with a known, fixed set of frontends should never allow every
  // origin on the internet to read its responses in a browser.
  CORS_ORIGIN: z
    .string({
      required_error: 'CORS_ORIGIN is required, e.g. http://localhost:5173',
    })
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    )
    .pipe(
      z
        .array(
          z.string().url('Each CORS_ORIGIN entry must be a valid URL, e.g. http://localhost:5173'),
        )
        .min(1, 'CORS_ORIGIN must list at least one origin')
        .refine((origins) => !origins.includes('*'), {
          message: 'CORS_ORIGIN must not be a wildcard ("*") — list explicit allowed origin(s)',
        }),
    ),
});

export type Config = z.infer<typeof envSchema>;

/**
 * Thrown when an environment object fails validation. The message is a
 * multi-line, human-readable list naming every invalid or missing
 * variable — this is what an operator sees in their terminal or in
 * container logs when the service refuses to start.
 */
export class EnvValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvValidationError';
  }
}

/**
 * Validates a raw environment object against envSchema.
 *
 * This is a pure function — it has no side effects and never calls
 * process.exit — specifically so it can be unit tested with an
 * arbitrary fake environment (see tests/config/env.test.ts). The
 * fail-fast behavior (logging the error and exiting the process) lives
 * one layer up, in src/config/index.ts, which is the only place this
 * function is called with the real process.env.
 */
export function parseEnv(rawEnv: NodeJS.ProcessEnv): Config {
  const result = envSchema.safeParse(rawEnv);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new EnvValidationError(
      `Invalid environment configuration. Fix the following and restart:\n${details}`,
    );
  }

  return result.data;
}
