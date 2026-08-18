import type { Express } from 'express';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../src/config/env.js';

let app: Express;
let config: Config;
let rateLimitRedisConnection: typeof import('../../src/lib/rateLimitRedis.js').rateLimitRedisConnection;

beforeAll(async () => {
  // Same dynamic-import-after-loadEnvFile requirement as tests/routes/health.test.ts —
  // src/app.ts transitively imports src/config at module-evaluation time.
  process.loadEnvFile('.env.test');
  ({ app } = await import('../../src/app.js'));
  ({ config } = await import('../../src/config/index.js'));
  ({ rateLimitRedisConnection } = await import('../../src/lib/rateLimitRedis.js'));

  // signupLimiter/loginLimiter are keyed by IP (src/middleware/rateLimit.ts),
  // and every supertest request in every test file shares the same loopback
  // IP. Step 1's in-memory store made that harmless — each test file ran in
  // its own process with its own private Map, so one file's signup volume
  // never affected another's. Step 2's Redis-backed store is real, shared,
  // durable state, so without this flush, this file's rate-limit budget
  // would depend on how much of it earlier test files (redirect.test.ts,
  // links.test.ts, googleAuth.test.ts — see their own beforeAll blocks)
  // happened to consume in the same 3-second window this file inherits from
  // .env.test, milliseconds earlier in the same `npm test` run. That's the
  // same category of problem tests/globalSetup.ts already solves for
  // Postgres with a dedicated test database — this is its Redis
  // equivalent, scoped to just the two IP-keyed limiters (unlock and
  // links-create are keyed per-link/per-user with globally unique test
  // fixtures, so they never collide across files regardless).
  const authLimiterKeys = await rateLimitRedisConnection.keys('rl:auth-*');
  if (authLimiterKeys.length > 0) {
    await rateLimitRedisConnection.del(...authLimiterKeys);
  }
});

function uniqueEmail(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

/** password_hash must never appear in a response body, under any key spelling. */
function assertNoPasswordHash(body: unknown): void {
  const serialized = JSON.stringify(body);
  expect(serialized.toLowerCase()).not.toContain('password_hash');
  expect(serialized.toLowerCase()).not.toContain('passwordhash');
  expect(serialized).not.toContain('$2a$');
  expect(serialized).not.toContain('$2b$');
}

describe('POST /api/auth/signup', () => {
  it('returns 201 with a user and token, no password_hash anywhere in the body', async () => {
    const email = uniqueEmail('route-signup');
    const res = await request(app)
      .post('/api/auth/signup')
      .send({ email, password: 'a-valid-password' });

    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe(email);
    expect(typeof res.body.token).toBe('string');
    assertNoPasswordHash(res.body);
  });

  it('rejects a password shorter than 8 characters with 400', async () => {
    const res = await request(app)
      .post('/api/auth/signup')
      .send({ email: uniqueEmail('route-shortpw'), password: 'short' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    assertNoPasswordHash(res.body);
  });

  it('rejects an invalid email with 400', async () => {
    const res = await request(app)
      .post('/api/auth/signup')
      .send({ email: 'not-an-email', password: 'a-valid-password' });

    expect(res.status).toBe(400);
    assertNoPasswordHash(res.body);
  });

  it('rejects a duplicate email with 409', async () => {
    const email = uniqueEmail('route-dup');
    await request(app).post('/api/auth/signup').send({ email, password: 'a-valid-password' });

    const res = await request(app)
      .post('/api/auth/signup')
      .send({ email, password: 'a-different-password' });

    expect(res.status).toBe(409);
    assertNoPasswordHash(res.body);
  });
});

describe('POST /api/auth/login', () => {
  it('returns 200 with a user and token on correct credentials', async () => {
    const email = uniqueEmail('route-login');
    await request(app).post('/api/auth/signup').send({ email, password: 'correct-password' });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email, password: 'correct-password' });

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(email);
    expect(typeof res.body.token).toBe('string');
    assertNoPasswordHash(res.body);
  });

  it('rejects wrong password and nonexistent email with 401 and IDENTICAL messages', async () => {
    const email = uniqueEmail('route-login-wrongpw');
    await request(app).post('/api/auth/signup').send({ email, password: 'correct-password' });

    const wrongPassword = await request(app)
      .post('/api/auth/login')
      .send({ email, password: 'incorrect-password' });
    const noSuchUser = await request(app)
      .post('/api/auth/login')
      .send({ email: uniqueEmail('route-login-nouser'), password: 'anything' });

    expect(wrongPassword.status).toBe(401);
    expect(noSuchUser.status).toBe(401);
    expect(wrongPassword.body.error.message).toBe(noSuchUser.body.error.message);
    assertNoPasswordHash(wrongPassword.body);
    assertNoPasswordHash(noSuchUser.body);
  });
});

describe('GET /api/auth/me', () => {
  it('returns 401 with no Authorization header', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('returns 401 with a malformed header (missing Bearer prefix)', async () => {
    const res = await request(app).get('/api/auth/me').set('Authorization', 'just-a-token');
    expect(res.status).toBe(401);
  });

  it('returns 401 with a tampered token', async () => {
    const email = uniqueEmail('route-me-tampered');
    const signupRes = await request(app)
      .post('/api/auth/signup')
      .send({ email, password: 'a-valid-password' });
    const validToken = signupRes.body.token as string;
    const tampered = `${validToken.slice(0, -1)}${validToken.at(-1) === 'a' ? 'b' : 'a'}`;

    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${tampered}`);
    expect(res.status).toBe(401);
  });

  it('returns 200 with the current user on a valid token', async () => {
    const email = uniqueEmail('route-me-ok');
    const signupRes = await request(app)
      .post('/api/auth/signup')
      .send({ email, password: 'a-valid-password' });
    const token = signupRes.body.token as string;

    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(email);
    assertNoPasswordHash(res.body);
  });
});

describe('rate limiting', () => {
  // signupLimiter/loginLimiter are keyed by IP (see src/middleware/
  // rateLimit.ts), a single counter shared with every other test in this
  // file that also hits these routes. Each test below waits out a full
  // window first so it starts counting from zero, rather than depending
  // on exactly how much budget earlier tests in this file happened to
  // consume.
  async function waitOutWindow(): Promise<void> {
    await new Promise((resolve) =>
      setTimeout(resolve, (config.RATE_LIMIT_AUTH_WINDOW_SECONDS + 1) * 1000),
    );
  }

  it('exceeding the signup limit returns 429 with Retry-After and RateLimit-* headers, and the window reset restores access', async () => {
    await waitOutWindow();

    let last: request.Response | undefined;
    for (let i = 0; i < config.RATE_LIMIT_AUTH_MAX + 1; i += 1) {
      const res = await request(app)
        .post('/api/auth/signup')
        .send({ email: uniqueEmail(`rl-signup-${i}`), password: 'a-valid-password' });
      if (i === 0) {
        // Headers are present on an allowed response too, not just a
        // blocked one — RateLimit-Remaining decrements from the max.
        expect(res.headers['ratelimit-limit']).toBe(String(config.RATE_LIMIT_AUTH_MAX));
        expect(res.headers['ratelimit-remaining']).toBe(String(config.RATE_LIMIT_AUTH_MAX - 1));
      }
      last = res;
    }

    expect(last!.status).toBe(429);
    expect(last!.body.error.code).toBe('TOO_MANY_REQUESTS');
    expect(last!.headers['ratelimit-remaining']).toBe('0');
    expect(Number(last!.headers['retry-after'])).toBeGreaterThan(0);

    await waitOutWindow();

    const restored = await request(app)
      .post('/api/auth/signup')
      .send({ email: uniqueEmail('rl-signup-restored'), password: 'a-valid-password' });
    expect(restored.status).toBe(201);
  }, 20000);

  it('signup and login have independent rate-limit budgets: exhausting signup does not block login from the same client', async () => {
    await waitOutWindow();

    const email = uniqueEmail('rl-independent-login');
    await request(app).post('/api/auth/signup').send({ email, password: 'correct-password' });

    let last: request.Response | undefined;
    for (let i = 0; i < config.RATE_LIMIT_AUTH_MAX; i += 1) {
      last = await request(app)
        .post('/api/auth/signup')
        .send({ email: uniqueEmail(`rl-independent-${i}`), password: 'a-valid-password' });
    }
    // The signup call above the loop plus RATE_LIMIT_AUTH_MAX more push
    // the signup counter one past its limit.
    expect(last!.status).toBe(429);

    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email, password: 'correct-password' });
    expect(loginRes.status).toBe(200);
  }, 20000);

  describe('fail-open when the rate-limit Redis connection is unavailable', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('a Redis error during the rate-limit check does not fail the request — the real handler still runs', async () => {
      // Mirrors the existing Redis-down pattern used for the link-lookup
      // cache in tests/routes/redirect.test.ts — a rate-limit check is
      // exactly the kind of layer that must never fail a request it's
      // optional on top of. Rejecting the one Redis command RedisStore
      // issues per increment (see src/middleware/rateLimit.ts's
      // sendCommand wrapper) simulates a live outage; passOnStoreError
      // should let the request through uncounted rather than 500ing or
      // 429ing.
      vi.spyOn(rateLimitRedisConnection, 'call').mockRejectedValueOnce(
        new Error('simulated Redis outage'),
      );

      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: uniqueEmail('rl-failopen'), password: 'wrong-password' });

      // The real login handler ran (401: no such user) — not a 500 from
      // an unhandled rate-limit error, and not a 429 from a limiter that
      // failed closed.
      expect(res.status).toBe(401);
    });
  });
});
