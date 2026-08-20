import type { Express } from 'express';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

let app: Express;

beforeAll(async () => {
  process.loadEnvFile('.env.test');
  ({ app } = await import('../../src/app.js'));
});

describe('GET /docs', () => {
  it('renders Swagger UI', async () => {
    const res = await request(app).get('/docs/');

    expect(res.status).toBe(200);
    expect(res.type).toBe('text/html');
    expect(res.text).toContain('swagger-ui');
  });
});

describe('GET /openapi.json', () => {
  it('serves the spec, listing every route', async () => {
    const res = await request(app).get('/openapi.json');

    expect(res.status).toBe(200);
    expect(res.type).toBe('application/json');

    const paths = Object.keys(res.body.paths);
    expect(paths).toEqual(
      expect.arrayContaining([
        '/',
        '/health',
        '/api/auth/signup',
        '/api/auth/login',
        '/api/auth/google',
        '/api/auth/google/callback',
        '/api/auth/me',
        '/api/links',
        '/api/links/{id}',
        '/api/links/{id}/stats',
        '/{shortCode}',
        '/{shortCode}/unlock',
      ]),
    );
  });
});
