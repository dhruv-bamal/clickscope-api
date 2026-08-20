import type { z } from 'zod';
import { EnvValidationError, envSchema } from '../src/config/env.js';

/**
 * The worker's own, narrower configuration — not a reuse of the API's
 * already-executed `config` singleton (src/config/index.ts), and not a
 * hand-duplicated copy of envSchema either.
 *
 * Reusing `config` directly isn't possible: it's a different process, and
 * more importantly most of envSchema (JWT_SECRET, GOOGLE_CLIENT_ID/SECRET,
 * GOOGLE_REDIRECT_URI, CORS_ORIGIN, FRONTEND_URL, BCRYPT_COST,
 * JWT_EXPIRES_IN) is HTTP/auth-specific and irrelevant to a process that
 * never serves a request — requiring the worker to also configure Google
 * OAuth secrets it never uses would be a pure liability (one more way for
 * `docker-compose.yml`/deploy config to be wrong) for zero benefit.
 *
 * `.pick(...)` reuses envSchema's actual validation rules (its DATABASE_URL
 * and REDIS_URL checks, its NODE_ENV/LOG_LEVEL enums) rather than
 * re-deriving them by hand — the single source of truth for "what does a
 * valid DATABASE_URL look like" stays in src/config/env.ts either way.
 *
 * Concurrency and retry/backoff parameters are deliberately kept as code
 * constants (see src/queues/clickQueue.ts, worker/index.ts) rather than
 * env vars — turning them into configuration surface is deployment-config
 * territory, explicitly out of scope for this phase.
 */
const workerEnvSchema = envSchema.pick({
  NODE_ENV: true,
  DATABASE_URL: true,
  REDIS_URL: true,
  LOG_LEVEL: true,
  SENTRY_DSN: true,
});

export type WorkerConfig = z.infer<typeof workerEnvSchema>;

export function parseWorkerEnv(rawEnv: NodeJS.ProcessEnv): WorkerConfig {
  const result = workerEnvSchema.safeParse(rawEnv);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new EnvValidationError(
      `Invalid worker environment configuration. Fix the following and restart:\n${details}`,
    );
  }

  return result.data;
}

/**
 * Mirrors src/config/index.ts's pattern exactly: validate once at process
 * startup, console.error + exit on failure (not the Pino logger — the
 * logger's own construction depends on this succeeding), export a single
 * typed singleton every other worker module imports instead of reading
 * process.env directly.
 */
let workerConfig: WorkerConfig;

try {
  workerConfig = parseWorkerEnv(process.env);
} catch (error) {
  if (error instanceof EnvValidationError) {
    console.error(
      `\n[clickscope-worker] Startup failed — invalid configuration.\n\n${error.message}\n`,
    );
  } else {
    console.error('[clickscope-worker] Unexpected error while loading configuration:', error);
  }
  process.exit(1);
}

export { workerConfig };
