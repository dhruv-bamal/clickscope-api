import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { conflict } from '../../src/lib/errors.js';
import { createErrorHandler } from '../../src/middleware/errorHandler.js';

/**
 * Proves Express 5's automatic async-rejection forwarding — the whole
 * point of this test is that NEITHER route below uses a try/catch NOR any
 * asyncHandler-style wrapper. In Express 4, a rejected promise from an
 * async handler was never seen by Express at all: the request would hang
 * with no response ever sent, unless the handler manually caught the
 * error and called next(err). Express 5 attaches that .catch()
 * automatically whenever a handler returns a Promise, so an async throw
 * behaves exactly like a synchronous throw always did — forwarded to
 * next(err), and therefore into the error-handling middleware below.
 */
function buildApp() {
  const app = express();

  app.get('/boom', async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    throw conflict('Async rejection reached the error handler');
  });

  app.get('/boom-native-error', async () => {
    await Promise.resolve();
    throw new Error('unexpected async failure');
  });

  app.use(createErrorHandler('development'));
  return app;
}

describe('Express 5 async error propagation', () => {
  it('forwards a rejected AppError from an async handler to the error middleware, with no try/catch or wrapper', async () => {
    const res = await request(buildApp()).get('/boom');

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
    expect(res.body.error.message).toBe('Async rejection reached the error handler');
  });

  it('forwards a rejected plain Error from an async handler the same way', async () => {
    const res = await request(buildApp()).get('/boom-native-error');

    expect(res.status).toBe(500);
    expect(res.body.error.message).toBe('unexpected async failure');
  });
});
