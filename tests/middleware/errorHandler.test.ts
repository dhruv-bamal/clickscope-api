import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  badRequest,
  conflict,
  forbidden,
  internal,
  notFound,
  tooManyRequests,
  unauthorized,
} from '../../src/lib/errors.js';
import { createErrorHandler } from '../../src/middleware/errorHandler.js';

function buildApp(nodeEnv: 'development' | 'production' | 'test') {
  const app = express();

  app.get('/bad-request', () => {
    throw badRequest('Invalid input', [{ field: 'email', message: 'Invalid email' }]);
  });
  app.get('/unauthorized', () => {
    throw unauthorized();
  });
  app.get('/forbidden', () => {
    throw forbidden();
  });
  app.get('/not-found', () => {
    throw notFound();
  });
  app.get('/conflict', () => {
    throw conflict('Email already in use');
  });
  app.get('/too-many-requests', () => {
    throw tooManyRequests();
  });
  app.get('/internal', () => {
    throw internal();
  });
  app.get('/unexpected', () => {
    throw new TypeError('cannot read property of undefined');
  });

  app.use(createErrorHandler(nodeEnv));
  return app;
}

describe('createErrorHandler', () => {
  it.each([
    ['/bad-request', 400, 'BAD_REQUEST'],
    ['/unauthorized', 401, 'UNAUTHORIZED'],
    ['/forbidden', 403, 'FORBIDDEN'],
    ['/not-found', 404, 'NOT_FOUND'],
    ['/conflict', 409, 'CONFLICT'],
    ['/too-many-requests', 429, 'TOO_MANY_REQUESTS'],
    ['/internal', 500, 'INTERNAL_ERROR'],
  ])('returns %i with code %s for %s', async (path, status, code) => {
    const res = await request(buildApp('development')).get(path);

    expect(res.status).toBe(status);
    expect(res.body.error.code).toBe(code);
    expect(res.body.error.requestId).toEqual(expect.any(String));
  });

  it('includes field-level details for a validation-style AppError', async () => {
    const res = await request(buildApp('development')).get('/bad-request');

    expect(res.body.error.details).toEqual([{ field: 'email', message: 'Invalid email' }]);
  });

  it('omits the details field entirely when there is nothing to report', async () => {
    const res = await request(buildApp('development')).get('/not-found');

    expect(res.body.error).not.toHaveProperty('details');
  });

  it('shows the real message for a non-AppError outside production', async () => {
    const res = await request(buildApp('development')).get('/unexpected');

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expect(res.body.error.message).toBe('cannot read property of undefined');
  });

  it('sanitizes a non-AppError message in production and never leaks it', async () => {
    const res = await request(buildApp('production')).get('/unexpected');

    expect(res.status).toBe(500);
    expect(res.body.error.message).toBe('Internal Server Error');
    expect(res.body.error.message).not.toContain('cannot read property');
    expect(JSON.stringify(res.body)).not.toContain('TypeError');
  });

  it('does not sanitize an AppError message in production — it is operational, not a bug', async () => {
    const res = await request(buildApp('production')).get('/conflict');

    expect(res.body.error.message).toBe('Email already in use');
  });
});
