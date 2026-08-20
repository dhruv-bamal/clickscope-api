import express, { Router } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { requestContext } from '../../src/middleware/requestContext.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// requestContext logs via req.log (a Pino child logger), not console — the
// only way to assert on the "Request completed" line's structured fields
// (route, in particular) is to intercept logger.child()'s returned
// instance and record what .info() was called with.
const infoCalls: Record<string, unknown>[] = [];
vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    child: () => ({
      info: (fields: Record<string, unknown>) => {
        infoCalls.push(fields);
      },
    }),
  },
}));

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

  describe('route pattern in the "Request completed" log line', () => {
    it('logs the matched route PATTERN, not the raw path — mirrors a real prefix-mounted router', async () => {
      infoCalls.length = 0;
      const app = express();
      app.use(requestContext);
      const prefixRouter = Router();
      prefixRouter.get('/:id', (_req, res) => res.json({ ok: true }));
      app.use('/prefix', prefixRouter);

      await request(app).get('/prefix/123e4567-e89b-12d3-a456-426614174000');

      const completed = infoCalls[infoCalls.length - 1];
      // path is req.path at res.on('finish') time — Express strips a
      // mounted sub-router's prefix from req.url for the duration of
      // that router's dispatch and never restores it before 'finish'
      // fires, so path here is mount-relative ('/123e4567-...'), not the
      // full request path. route (built from req.baseUrl + req.route.path)
      // is unaffected by that quirk, which is exactly why it — not path —
      // is the field safe to aggregate by.
      expect(completed).toMatchObject({
        method: 'GET',
        route: '/prefix/:id',
        path: '/123e4567-e89b-12d3-a456-426614174000',
      });
    });

    it('logs the flat pattern for a flat-mounted route, matching the real redirectRouter shape', async () => {
      infoCalls.length = 0;
      const app = express();
      app.use(requestContext);
      app.get('/:shortCode', (_req, res) => res.json({ ok: true }));

      await request(app).get('/abc123');

      const completed = infoCalls[infoCalls.length - 1];
      expect(completed).toMatchObject({ route: '/:shortCode' });
    });

    it('logs "unmatched" for a request that never reaches a route', async () => {
      infoCalls.length = 0;
      const app = express();
      app.use(requestContext);
      app.use((_req, res) => {
        res.status(404).json({});
      });

      await request(app).get('/nonexistent');

      const completed = infoCalls[infoCalls.length - 1];
      expect(completed).toMatchObject({ route: 'unmatched' });
    });
  });
});
