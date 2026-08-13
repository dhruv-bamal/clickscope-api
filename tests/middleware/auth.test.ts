import type { Express } from 'express';
import express from 'express';
import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// Hoisted above imports by Vitest's transform. requireAuth imports
// tokenService.verifyToken directly, so mocking it here drives every
// branch (missing header, invalid, expired, success) without real JWTs —
// and sidesteps needing a real JWT_SECRET for this file, since the mocked
// module never touches src/config at all.
vi.mock('../../src/services/tokenService.js', () => ({
  verifyToken: vi.fn(),
}));

let app: Express;
let verifyToken: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  // requestContext still transitively imports src/config (via src/lib/logger.js),
  // even though tokenService is mocked above — same loadEnvFile-before-
  // dynamic-import requirement as every other file touching src/config.
  process.loadEnvFile('.env.test');

  const tokenService = (await import('../../src/services/tokenService.js')) as unknown as {
    verifyToken: ReturnType<typeof vi.fn>;
  };
  verifyToken = tokenService.verifyToken;

  const { requestContext } = await import('../../src/middleware/requestContext.js');
  const { requireAuth } = await import('../../src/middleware/auth.js');
  const { createErrorHandler } = await import('../../src/middleware/errorHandler.js');

  app = express();
  app.use(requestContext);
  app.get('/protected', requireAuth, (req, res) => {
    res.status(200).json({ userId: req.userId });
  });
  app.use(createErrorHandler('development'));
});

describe('requireAuth', () => {
  it('rejects with 401 when the Authorization header is missing', async () => {
    const res = await request(app).get('/protected');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(verifyToken).not.toHaveBeenCalled();
  });

  it('rejects with 401 when the header is missing the Bearer prefix', async () => {
    const res = await request(app).get('/protected').set('Authorization', 'some-raw-token');

    expect(res.status).toBe(401);
    expect(verifyToken).not.toHaveBeenCalled();
  });

  it('rejects with 401 when the token is invalid', async () => {
    verifyToken.mockReturnValue({ ok: false, reason: 'invalid' });

    const res = await request(app).get('/protected').set('Authorization', 'Bearer garbage');

    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Invalid or expired token');
  });

  it('rejects with 401 and an IDENTICAL message when the token is expired', async () => {
    verifyToken.mockReturnValue({ ok: false, reason: 'expired' });

    const res = await request(app).get('/protected').set('Authorization', 'Bearer stale-token');

    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Invalid or expired token');
  });

  it('attaches req.userId and calls next() on a valid token', async () => {
    verifyToken.mockReturnValue({
      ok: true,
      payload: { sub: 'user-abc', iat: 0, exp: 9999999999 },
    });

    const res = await request(app).get('/protected').set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(200);
    expect(res.body.userId).toBe('user-abc');
  });
});
