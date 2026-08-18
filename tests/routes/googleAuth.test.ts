import type { Express } from 'express';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// Only exchangeCodeForIdentity (the network/crypto call into Google) is
// mocked, via importOriginal, so callback tests can control the identity
// outcome per case. buildGoogleAuthUrl runs for real — it's pure
// string-building with no network involved, so /google's redirect target
// is genuine, not faked.
vi.mock('../../src/services/oauthService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/oauthService.js')>();
  return { ...actual, exchangeCodeForIdentity: vi.fn() };
});

let app: Express;
let exchangeCodeForIdentity: ReturnType<typeof vi.fn>;
let verifyToken: typeof import('../../src/services/tokenService.js').verifyToken;
let query: typeof import('../../src/db/pool.js').query;
let rateLimitRedisConnection: typeof import('../../src/lib/rateLimitRedis.js').rateLimitRedisConnection;

beforeAll(async () => {
  process.loadEnvFile('.env.test');
  ({ app } = await import('../../src/app.js'));
  const oauthService = await import('../../src/services/oauthService.js');
  exchangeCodeForIdentity = oauthService.exchangeCodeForIdentity as unknown as ReturnType<
    typeof vi.fn
  >;
  ({ verifyToken } = await import('../../src/services/tokenService.js'));
  ({ query } = await import('../../src/db/pool.js'));
  ({ rateLimitRedisConnection } = await import('../../src/lib/rateLimitRedis.js'));

  // See tests/routes/auth.test.ts's beforeAll for why this file-local flush
  // is necessary now that signupLimiter/loginLimiter are backed by real,
  // shared Redis rather than a per-process in-memory Map: every test file's
  // supertest requests share one loopback IP, so without this flush this
  // file's one signup call below could inherit budget already spent by
  // whichever file ran immediately before it in the same `npm test` run.
  const authLimiterKeys = await rateLimitRedisConnection.keys('rl:auth-*');
  if (authLimiterKeys.length > 0) {
    await rateLimitRedisConnection.del(...authLimiterKeys);
  }
});

afterEach(() => {
  exchangeCodeForIdentity.mockReset();
});

function uniqueEmail(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

function uniqueOAuthId(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** password_hash must never appear in a response body, under any key spelling. */
function assertNoPasswordHash(body: unknown): void {
  const serialized = JSON.stringify(body);
  expect(serialized.toLowerCase()).not.toContain('password_hash');
  expect(serialized.toLowerCase()).not.toContain('passwordhash');
  expect(serialized).not.toContain('$2a$');
  expect(serialized).not.toContain('$2b$');
}

/** Hits GET /google for real to obtain a freshly-issued, currently-valid state value. */
async function getState(): Promise<string> {
  const res = await request(app).get('/api/auth/google');
  const location = res.headers.location as string;
  const state = new URL(location).searchParams.get('state');
  if (!state) throw new Error('Expected a state parameter in the redirect URL');
  return state;
}

// The token is carried in the URL fragment, not the query string (see
// src/routes/auth.ts) — never sent to any server, so URL's own query
// parser can't see it; it has to be parsed out of `.hash` instead.
function tokenFromRedirect(location: string): string {
  const fragment = new URL(location).hash;
  const token = new URLSearchParams(fragment.slice(1)).get('token');
  if (!token) throw new Error('Expected a token in the redirect URL fragment');
  return token;
}

function subFromToken(token: string): string {
  const result = verifyToken(token);
  if (!result.ok) throw new Error('Expected a valid token');
  return result.payload.sub;
}

describe('GET /api/auth/google', () => {
  it("redirects to Google's consent screen with client_id, state, and the requested scopes", async () => {
    const res = await request(app).get('/api/auth/google');

    expect(res.status).toBe(302);
    const location = res.headers.location as string;
    expect(location).toContain('accounts.google.com');

    const url = new URL(location);
    expect(url.searchParams.get('client_id')).toBe(process.env.GOOGLE_CLIENT_ID);
    expect(url.searchParams.get('state')).toBeTruthy();
    const scope = url.searchParams.get('scope') ?? '';
    expect(scope).toContain('openid');
    expect(scope).toContain('email');
    expect(scope).toContain('profile');
  });

  it('issues a different state on each call', async () => {
    const first = await getState();
    const second = await getState();
    expect(first).not.toBe(second);
  });
});

describe('GET /api/auth/google/callback', () => {
  it('rejects a missing state with 400', async () => {
    const res = await request(app)
      .get('/api/auth/google/callback')
      .query({ code: 'irrelevant' });

    expect(res.status).toBe(400);
    expect(exchangeCodeForIdentity).not.toHaveBeenCalled();
  });

  it('rejects an unknown (never-issued) state with 400', async () => {
    const res = await request(app)
      .get('/api/auth/google/callback')
      .query({ state: 'never-issued-state', code: 'irrelevant' });

    expect(res.status).toBe(400);
    expect(exchangeCodeForIdentity).not.toHaveBeenCalled();
  });

  it('rejects a reused state with 400 on the second attempt (single-use, replay fails)', async () => {
    const state = await getState();
    exchangeCodeForIdentity.mockResolvedValue({
      googleId: uniqueOAuthId('reuse'),
      email: uniqueEmail('reuse'),
      emailVerified: true,
    });

    const first = await request(app)
      .get('/api/auth/google/callback')
      .query({ state, code: 'a-code' });
    expect(first.status).toBe(302);

    const second = await request(app)
      .get('/api/auth/google/callback')
      .query({ state, code: 'a-code' });
    expect(second.status).toBe(400);
  });

  it('rejects a valid state with no code and no error with 400', async () => {
    const state = await getState();
    const res = await request(app).get('/api/auth/google/callback').query({ state });

    expect(res.status).toBe(400);
    expect(exchangeCodeForIdentity).not.toHaveBeenCalled();
  });

  it('handles denied consent (?error=) as a redirect, not a server error, without exchanging a code', async () => {
    const state = await getState();

    const res = await request(app)
      .get('/api/auth/google/callback')
      .query({ state, error: 'access_denied' });

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain(process.env.FRONTEND_URL);
    expect(res.headers.location).toContain('error=oauth_denied');
    expect(exchangeCodeForIdentity).not.toHaveBeenCalled();
  });

  it('a valid state+code with a new identity creates a user and redirects with a valid token', async () => {
    const state = await getState();
    const email = uniqueEmail('callback-new');
    exchangeCodeForIdentity.mockResolvedValue({
      googleId: uniqueOAuthId('callback-new'),
      email,
      emailVerified: true,
    });

    const res = await request(app)
      .get('/api/auth/google/callback')
      .query({ state, code: 'a-code' });

    expect(res.status).toBe(302);
    const location = res.headers.location as string;
    expect(location.startsWith(process.env.FRONTEND_URL as string)).toBe(true);

    const token = tokenFromRedirect(location);
    const result = verifyToken(token);
    expect(result.ok).toBe(true);

    const userId = subFromToken(token);
    const stored = await query<{ email: string; password_hash: string | null }>(
      'SELECT email, password_hash FROM users WHERE id = $1',
      [userId],
    );
    expect(stored.rows[0]?.email).toBe(email);
    expect(stored.rows[0]?.password_hash).toBeNull();
  });

  it('a returning identity (same provider + oauth_id) logs in as the same user, not a duplicate', async () => {
    const googleId = uniqueOAuthId('callback-return');
    const email = uniqueEmail('callback-return');
    exchangeCodeForIdentity.mockResolvedValue({ googleId, email, emailVerified: true });

    const firstState = await getState();
    const first = await request(app)
      .get('/api/auth/google/callback')
      .query({ state: firstState, code: 'a-code' });
    const firstUserId = subFromToken(tokenFromRedirect(first.headers.location as string));

    const secondState = await getState();
    const second = await request(app)
      .get('/api/auth/google/callback')
      .query({ state: secondState, code: 'a-code' });
    const secondUserId = subFromToken(tokenFromRedirect(second.headers.location as string));

    expect(secondUserId).toBe(firstUserId);
  });

  it('rejects with 409 when the Google email matches an existing password account, creating no row', async () => {
    const email = uniqueEmail('callback-conflict');
    await request(app).post('/api/auth/signup').send({ email, password: 'a-valid-password' });

    const before = await query<{ count: number }>(
      'SELECT count(*)::int AS count FROM users WHERE lower(email) = lower($1)',
      [email],
    );
    expect(before.rows[0]?.count).toBe(1);

    exchangeCodeForIdentity.mockResolvedValue({
      googleId: uniqueOAuthId('callback-conflict'),
      email,
      emailVerified: true,
    });

    const state = await getState();
    const res = await request(app)
      .get('/api/auth/google/callback')
      .query({ state, code: 'a-code' });

    expect(res.status).toBe(409);
    assertNoPasswordHash(res.body);

    const after = await query<{ count: number }>(
      'SELECT count(*)::int AS count FROM users WHERE lower(email) = lower($1)',
      [email],
    );
    expect(after.rows[0]?.count).toBe(1);
  });

  it('rejects with 400 when Google reports the email as unverified, creating no row', async () => {
    const email = uniqueEmail('callback-unverified');
    exchangeCodeForIdentity.mockResolvedValue({
      googleId: uniqueOAuthId('callback-unverified'),
      email,
      emailVerified: false,
    });

    const state = await getState();
    const res = await request(app)
      .get('/api/auth/google/callback')
      .query({ state, code: 'a-code' });

    expect(res.status).toBe(400);
    assertNoPasswordHash(res.body);

    const after = await query<{ count: number }>(
      'SELECT count(*)::int AS count FROM users WHERE lower(email) = lower($1)',
      [email],
    );
    expect(after.rows[0]?.count).toBe(0);
  });
});
