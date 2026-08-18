import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import type { Request } from 'express';
import { RedisStore, type SendCommandFn } from 'rate-limit-redis';
import { config } from '../config/index.js';
import { tooManyRequests } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { rateLimitRedisConnection } from '../lib/rateLimitRedis.js';
import { MAX_ALIAS_LENGTH } from '../lib/shortCode.js';

/**
 * express-rate-limit's own internal error/warning logging (e.g. the
 * message it logs when passOnStoreError below lets a request through)
 * defaults to a plain console.error/console.warn logger — this project's
 * "structured logging via Pino, no console.log" rule (see CLAUDE.md)
 * applies to a dependency's internal logging just as much as to code
 * written here, so every limiter is given this adapter instead of
 * accepting that default.
 */
const pinoAdapterLogger = {
  warn: (err: unknown) => logger.warn({ err }, 'express-rate-limit warning'),
  error: (err: unknown) => logger.error({ err }, 'express-rate-limit error'),
};

/**
 * One place all four of this phase's rate limiters are built, so the
 * configuration that's identical across all of them — standard headers,
 * no legacy headers, and how a 429 gets turned into this app's normal
 * AppError/error-middleware response shape instead of express-rate-
 * limit's own plain-text default — isn't repeated four times with four
 * chances to drift.
 *
 * Step 1 (this file, initially): express-rate-limit's default in-memory
 * store — a Map keyed by whatever keyGenerator returns, counting hits per
 * key within a fixed window. Correct within a single process, silently
 * wrong across more than one (see Notes.md, "Phase 10: Rate Limiting" /
 * "In-memory state and the silent N-instance multiplication problem").
 *
 * `standardHeaders: 'draft-6'` emits separate RateLimit-Limit /
 * RateLimit-Remaining / RateLimit-Reset / RateLimit-Policy headers (the
 * IETF draft revision express-rate-limit implements as discrete headers —
 * 'draft-7' combines them into one opaque `RateLimit: limit=…,
 * remaining=…, reset=…` header instead, which is harder for a client or a
 * test to read a single value out of) on every response, and Retry-After
 * specifically on a blocked (429) one. `legacyHeaders: false` suppresses
 * the older X-RateLimit-* trio — no client of this API needs both header
 * families.
 *
 * Step 2: the store is now `rate-limit-redis`'s RedisStore, backed by
 * `rateLimitRedisConnection` (src/lib/rateLimitRedis.ts) — a dedicated
 * connection, not the shared cache client or BullMQ's queue connection,
 * for the same "one connection per consumer" reasoning Phase 9 already
 * established for the queue. `passOnStoreError: true` is the actual
 * fail-open mechanism: if a Redis command this store issues fails, that
 * request is let through uncounted rather than the request itself
 * failing — extending Phase 8's "a layer that can fail must never fail
 * the request" precedent to this layer. See Notes.md, "Phase 10: Rate
 * Limiting."
 */
function buildLimiter(opts: {
  windowSeconds: number;
  max: number;
  name: string;
  keyGenerator?: (req: Request) => string;
}) {
  return rateLimit({
    windowMs: opts.windowSeconds * 1000,
    limit: opts.max,
    standardHeaders: 'draft-6',
    legacyHeaders: false,
    logger: pinoAdapterLogger,
    passOnStoreError: true,
    store: new RedisStore({
      prefix: `rl:${opts.name}:`,
      // ioredis's `.call` overload requires its first argument typed
      // separately from the rest (a plain string[] spread doesn't satisfy
      // it), and returns `Promise<unknown>` rather than the RedisReply
      // union this store's SendCommandFn expects — both purely typing
      // mismatches between the two libraries' signatures for the same
      // "send a raw Redis command" operation, not a behavioral gap.
      sendCommand: ((...args: string[]) =>
        rateLimitRedisConnection.call(args[0] as string, ...args.slice(1))) as SendCommandFn,
    }),
    ...(opts.keyGenerator ? { keyGenerator: opts.keyGenerator } : {}),
    // express-rate-limit's default `handler` writes its own plain-text
    // response directly to `res`, bypassing createErrorHandler entirely —
    // that would give 429s a different body shape than every other error
    // in this API. Routing through next(tooManyRequests(...)) instead
    // means a 429 gets the exact same { error: { code, message,
    // requestId, details } } envelope as a 400/401/404/410. The headers
    // above are already set on `res` by the time this runs (express-
    // rate-limit sets them before invoking `handler`), so Retry-After is
    // read back off `res` here rather than recomputed — one source of
    // truth for the value, not two.
    handler: (req, res, next) => {
      const retryAfterSeconds = Number(res.getHeader('Retry-After')) || opts.windowSeconds;
      req.log.warn({ limiter: opts.name, path: req.path }, 'Rate limit exceeded');
      next(tooManyRequests('Too many requests. Please try again later.', { retryAfterSeconds }));
    },
  });
}

// --- POST /api/auth/signup and POST /api/auth/login --------------------
//
// Both hash or compare a bcrypt password on every request (see
// passwordService.ts — signup calls hashPassword, login calls either
// verifyPassword or, on the "no such user" path, verifyAgainstDummyHash).
// bcryptjs is pure JS: that work runs synchronously on Node's single
// event-loop thread, not off it. A burst of concurrent login attempts
// doesn't just cost that request time — it blocks every other request
// this process is handling, including the redirect path Phases 8-9
// optimized. That's the strongest argument for limiting these two routes
// specifically: this isn't really about "stop N login guesses," it's
// about keeping bcrypt's cost from becoming a denial-of-service lever
// against the rest of the app. See Notes.md, "Phase 10: Rate Limiting" /
// "Why rate limit auth at all."
//
// Two separate limiter instances, not one shared across both routes,
// keyed by IP (no user identity exists yet at signup; login stays
// IP-keyed too rather than email-keyed — see Notes.md's "keying
// strategies" for the account-lockout-DoS tradeoff that decision avoids).
// Separate instances mean exhausting signup's budget never blocks a
// legitimate login from the same IP, and vice versa.
export const signupLimiter = buildLimiter({
  windowSeconds: config.RATE_LIMIT_AUTH_WINDOW_SECONDS,
  max: config.RATE_LIMIT_AUTH_MAX,
  name: 'auth-signup',
});

export const loginLimiter = buildLimiter({
  windowSeconds: config.RATE_LIMIT_AUTH_WINDOW_SECONDS,
  max: config.RATE_LIMIT_AUTH_MAX,
  name: 'auth-login',
});

// --- POST /:shortCode/unlock --------------------------------------------
//
// Keyed by IP *composed with* the shortCode being attacked, not IP alone.
// Phase 7 flagged this exact gap: a per-IP-only limit here would let an
// attacker brute-force link A, exhaust link A's budget, and then be
// completely unthrottled against link B from the same address one request
// later — the resource actually being protected (one link's password) has
// nothing to do with a global-per-IP counter. shortCode is truncated to
// MAX_ALIAS_LENGTH before being folded into the key: an attacker could
// otherwise send an arbitrarily long path segment purely to bloat the
// rate-limit keyspace, which costs nothing to guard against since
// customAliasSchema already bounds every real shortCode to this length.
//
// ipKeyGenerator() (not raw req.ip concatenation) is required here, not a
// style choice — express-rate-limit statically scans a custom
// keyGenerator's source for "req.ip" and throws ERR_ERL_KEY_GEN_IPV6 at
// startup if it's present without a call to ipKeyGenerator, because
// naively concatenating req.ip lets an attacker rotate between
// IPv4-mapped-IPv6 forms of the same address to reset their counter (see
// GHSA-46wh-pxpv-q5gq).
export const unlockLimiter = buildLimiter({
  windowSeconds: config.RATE_LIMIT_UNLOCK_WINDOW_SECONDS,
  max: config.RATE_LIMIT_UNLOCK_MAX,
  name: 'redirect-unlock',
  keyGenerator: (req) =>
    `${ipKeyGenerator(req.ip ?? '')}:${(req.params.shortCode ?? '').slice(0, MAX_ALIAS_LENGTH)}`,
});

// --- POST /api/links -----------------------------------------------------
//
// Keyed by req.userId, not IP — this route sits behind requireAuth, so a
// real identity already exists by the time this middleware runs (it's
// mounted after requireAuth in links.ts specifically so req.userId is
// populated here). Keying by user rather than IP is both more accurate
// (multiple legitimate users can share an office/CGNAT IP; this limiter
// shouldn't punish user B for user A's burst) and isolates the test
// suite's per-test freshly-signed-up users from each other automatically.
// The honest gap this doesn't solve: an attacker who creates a fresh user
// for every burst sidesteps this entirely — that's account-creation abuse
// (bounded by the signup limiter above), a different problem than
// link-creation rate, and out of this phase's scope.
export const linksCreateLimiter = buildLimiter({
  windowSeconds: config.RATE_LIMIT_LINKS_WINDOW_SECONDS,
  max: config.RATE_LIMIT_LINKS_MAX,
  name: 'links-create',
  keyGenerator: (req) => req.userId ?? ipKeyGenerator(req.ip ?? ''),
});
