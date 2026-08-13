import type { Express } from 'express';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

let app: Express;

beforeAll(async () => {
  // Same dynamic-import-after-loadEnvFile requirement as tests/routes/health.test.ts —
  // src/app.ts transitively imports src/config at module-evaluation time.
  process.loadEnvFile('.env.test');
  ({ app } = await import('../../src/app.js'));
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
