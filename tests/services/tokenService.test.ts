import jwt from 'jsonwebtoken';
import { beforeAll, describe, expect, it } from 'vitest';

// jsonwebtoken itself has no dependency on src/config (it doesn't read
// process.env at module-evaluation time), so a plain static import is safe
// here — only imports that transitively pull in src/config/index.ts need
// the dynamic-import-after-loadEnvFile treatment (see tokenService/*
// dynamic import below).
let signToken: typeof import('../../src/services/tokenService.js').signToken;
let verifyToken: typeof import('../../src/services/tokenService.js').verifyToken;

beforeAll(async () => {
  process.loadEnvFile('.env.test');
  ({ signToken, verifyToken } = await import('../../src/services/tokenService.js'));
});

describe('tokenService', () => {
  it('round-trips: a freshly signed token verifies with the matching sub', () => {
    const token = signToken('user-123');
    const result = verifyToken(token);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.sub).toBe('user-123');
      expect(result.payload.iat).toEqual(expect.any(Number));
      expect(result.payload.exp).toEqual(expect.any(Number));
    }
  });

  it('rejects a garbage string as invalid', () => {
    const result = verifyToken('not-a-jwt-at-all');
    expect(result).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects a token whose payload was tampered with after signing', () => {
    const token = signToken('user-123');
    const [header, _payload, signature] = token.split('.');
    const tamperedPayload = Buffer.from(
      JSON.stringify({ sub: 'someone-else', iat: 0, exp: 9999999999 }),
    ).toString('base64url');

    const tampered = `${header}.${tamperedPayload}.${signature}`;
    expect(verifyToken(tampered)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects an already-expired token', () => {
    // signToken always uses config.JWT_EXPIRES_IN ('7d' in .env.test), so
    // to produce an expired token here without sleeping in the test, sign
    // directly with jsonwebtoken using a negative expiry against the same
    // secret loaded into process.env by beforeAll.
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error('JWT_SECRET is not set — check .env.test');

    const expiredToken = jwt.sign({}, secret, { subject: 'user-123', expiresIn: -10 });

    expect(verifyToken(expiredToken)).toEqual({ ok: false, reason: 'expired' });
  });
});
