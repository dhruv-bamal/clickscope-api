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

  // Signs and verifies JWTs (HS256 — symmetric). Required with no default:
  // a leaked or guessable secret lets an attacker mint a valid token for
  // any user id, so falling back to a built-in default would be a
  // vulnerability, not a convenience. 32 chars is a floor, not a target —
  // generate with e.g. `openssl rand -base64 48`.
  JWT_SECRET: z
    .string({
      required_error: 'JWT_SECRET is required, e.g. a random string of 32+ characters',
    })
    .min(32, 'JWT_SECRET must be at least 32 characters'),

  // How long an issued token stays valid before the client must sign in
  // again. Passed straight through to jsonwebtoken's expiresIn option,
  // which parses its own duration strings — no extra validation needed
  // here beyond "is a string."
  JWT_EXPIRES_IN: z.string().default('7d'),

  // bcrypt's work factor: each increment doubles hashing time. 12 is a
  // reasonable 2024+ default (~200-300ms/hash on typical hardware).
  // Lowered in .env.test so the test suite (which hashes/compares many
  // times) stays fast without touching the production-realistic default.
  BCRYPT_COST: z.coerce
    .number({ invalid_type_error: 'BCRYPT_COST must be a number' })
    .int('BCRYPT_COST must be an integer')
    .default(12),

  // Google OAuth 2.0 client ID, from Google Cloud Console's "OAuth 2.0
  // Client IDs" for this project. Public by design (it's embedded in the
  // authorization URL the browser is redirected to) but still required
  // with no default — an unset value would silently break every
  // /api/auth/google request rather than fail fast at startup.
  GOOGLE_CLIENT_ID: z
    .string({
      required_error: 'GOOGLE_CLIENT_ID is required, e.g. 123456789-abc.apps.googleusercontent.com',
    })
    .min(1, 'GOOGLE_CLIENT_ID must not be empty'),

  // Paired secret for GOOGLE_CLIENT_ID. Authenticates this server (never
  // the browser) to Google's token endpoint during code exchange. Required
  // with no default for the same reason JWT_SECRET is: a leaked or
  // missing value is a security/availability problem, not something to
  // default around.
  GOOGLE_CLIENT_SECRET: z
    .string({
      required_error: 'GOOGLE_CLIENT_SECRET is required — from Google Cloud Console',
    })
    .min(1, 'GOOGLE_CLIENT_SECRET must not be empty'),

  // Must exactly match a redirect URI registered for this client in
  // Google Cloud Console, or Google rejects the code exchange.
  GOOGLE_REDIRECT_URI: z
    .string({
      required_error:
        'GOOGLE_REDIRECT_URI is required, e.g. http://localhost:3000/api/auth/google/callback',
    })
    .url('GOOGLE_REDIRECT_URI must be a valid URL'),

  // Where the OAuth callback redirects the browser after login (success,
  // denial, or rejection), carrying the issued JWT as a query parameter.
  // Required with no default: silently falling back to some built-in URL
  // on a misconfigured deploy is worse than refusing to boot.
  FRONTEND_URL: z
    .string({ required_error: 'FRONTEND_URL is required, e.g. http://localhost:5173' })
    .url('FRONTEND_URL must be a valid URL'),

  // How many hops of X-Forwarded-For Express should trust when deriving
  // req.ip — passed straight to app.set('trust proxy', ...). 0 (the
  // default) means "trust nothing but the real TCP socket," which is
  // correct for local dev and this test suite, where nothing sits in
  // front of the app. A deployment behind a load balancer or CDN (Phase
  // 15 puts this behind Render's) must set this to the number of proxy
  // hops in front of it — typically 1 for a single load balancer — or
  // every IP-keyed rate limiter below collapses every user onto the
  // proxy's one address. Never defaulted to 1 here: trusting a hop that
  // doesn't exist yet would let a client spoof X-Forwarded-For straight
  // past every IP-keyed limiter. See Notes.md, "Phase 10: Rate Limiting."
  TRUST_PROXY: z.coerce
    .number({ invalid_type_error: 'TRUST_PROXY must be a number' })
    .int('TRUST_PROXY must be an integer')
    .min(0, 'TRUST_PROXY must be 0 or greater')
    .default(0),

  // Auth (signup/login) rate limit: bcryptjs hashes/compares synchronously
  // on the event loop, so unthrottled concurrent attempts here can stall
  // every other request this process is handling, redirect path included.
  // See Notes.md, "Phase 10: Rate Limiting" / "Why rate limit auth at all."
  RATE_LIMIT_AUTH_WINDOW_SECONDS: z.coerce.number().int().positive().default(900),
  RATE_LIMIT_AUTH_MAX: z.coerce.number().int().positive().default(5),

  // POST /:shortCode/unlock rate limit — keyed per IP+link (see
  // src/middleware/rateLimit.ts), so this budget is per link being
  // attacked, not shared across every link an attacker tries.
  RATE_LIMIT_UNLOCK_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_UNLOCK_MAX: z.coerce.number().int().positive().default(5),

  // POST /api/links rate limit — keyed per authenticated user, not IP.
  RATE_LIMIT_LINKS_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_LINKS_MAX: z.coerce.number().int().positive().default(20),

  // Sentry project DSN. Optional, no default: local dev shouldn't require
  // provisioning a Sentry project just to boot — every Sentry.* call in
  // this app (src/lib/sentry.ts) safely no-ops when init() was never
  // called. Despite looking secret-shaped, a DSN is not a credential: it
  // only identifies where to send events, carries no read/query
  // capability, and Sentry's own client SDKs are designed to be embedded
  // in shipped browser bundles. Safe to expose to the client (relevant
  // for a future browser-side Sentry integration) for the same reason a
  // Stripe *publishable* key is safe to expose despite the word "key" —
  // see Notes.md, "Phase 14a: Observability & API Documentation."
  // `.preprocess` runs before `.optional()`/`.url()` see the value, so an
  // empty string is normalized to undefined first. This matters because
  // `.optional()` alone only treats an *absent* key as unset — an empty
  // string is a present value as far as Zod is concerned, and would fail
  // `.url()`. Empty strings reach here in practice because Node's
  // `--env-file` and Docker Compose's `env_file:` both parse a bare
  // `SENTRY_DSN=` line (value intentionally left blank to disable Sentry)
  // as `""`, not as an absent variable. See Notes.md, "Phase 15a:
  // Containerization & CI" / "Empty string vs. absent: the --env-file trap."
  SENTRY_DSN: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().url('SENTRY_DSN must be a valid URL').optional(),
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
