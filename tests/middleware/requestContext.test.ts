import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { requestContext } from '../../src/middleware/requestContext.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function buildApp() {
  const app = express();
  app.use(requestContext);
  app.get('/whoami', (req, res) => {
    res.json({ id: req.id });
  });
  return app;
}

describe('requestContext middleware', () => {
  it('generates a UUID request ID and echoes it in the X-Request-Id response header', async () => {
    const res = await request(buildApp()).get('/whoami');

    expect(res.headers['x-request-id']).toMatch(UUID_PATTERN);
    expect(res.body.id).toBe(res.headers['x-request-id']);
  });

  it('echoes back an inbound X-Request-Id verbatim instead of generating a new one', async () => {
    const res = await request(buildApp())
      .get('/whoami')
      .set('X-Request-Id', 'client-supplied-id-123');

    expect(res.headers['x-request-id']).toBe('client-supplied-id-123');
    expect(res.body.id).toBe('client-supplied-id-123');
  });

  it('ignores an excessively long inbound header and generates a fresh UUID instead', async () => {
    const res = await request(buildApp()).get('/whoami').set('X-Request-Id', 'x'.repeat(500));

    expect(res.headers['x-request-id']).toMatch(UUID_PATTERN);
  });

  it('generates a different ID for each request', async () => {
    const app = buildApp();
    const first = await request(app).get('/whoami');
    const second = await request(app).get('/whoami');

    expect(first.headers['x-request-id']).not.toBe(second.headers['x-request-id']);
  });
});
