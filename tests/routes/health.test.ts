import type { Express } from 'express';
import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// vi.mock factories are hoisted above imports by Vitest's transform, so
// this registration is in place before anything below tries to resolve
// '../../src/db/health.js' — but note that hoisting only affects module
// *resolution*, not the env-loading timing handled separately below.
vi.mock('../../src/db/health.js', () => ({
  checkDatabaseHealth: vi.fn(),
}));

let app: Express;
let checkDatabaseHealth: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  // src/config/index.ts reads process.env at MODULE-EVALUATION time (a
  // top-level parseEnv(process.env) call), not inside a function. A
  // static `import { app } from '../../src/app.js'` at the top of this
  // file would have that whole dependency graph evaluated before any of
  // this file's own top-level statements run — including a
  // process.loadEnvFile() call placed textually above it — because ES
  // module imports are always evaluated before the importing module's
  // own body, regardless of source order. A dynamic import() inside this
  // beforeAll defers evaluation until this line actually runs, i.e.
  // after loadEnvFile has populated process.env.
  process.loadEnvFile('.env.test');

  const dbHealth = (await import('../../src/db/health.js')) as unknown as {
    checkDatabaseHealth: ReturnType<typeof vi.fn>;
  };
  checkDatabaseHealth = dbHealth.checkDatabaseHealth;

  ({ app } = await import('../../src/app.js'));
});

describe('GET /health', () => {
  // checkDatabaseHealth is mocked so both the healthy and unhealthy
  // branches are producible on demand — a currently-healthy local
  // Postgres can't be made to fail on command. checkRedisHealth is
  // deliberately left unmocked and hits the real local Redis; see
  // Notes.md, "Phase 3: API Foundation" for the tradeoff behind that
  // asymmetry and what it implies for CI.
  it('returns 200 with status "ok" when every dependency is healthy', async () => {
    checkDatabaseHealth.mockResolvedValue(true);

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.checks.database).toEqual({ status: 'ok', latencyMs: expect.any(Number) });
    expect(res.body.checks.redis).toEqual({ status: 'ok', latencyMs: expect.any(Number) });
  });

  it('returns 503 with status "degraded" when a dependency is unreachable', async () => {
    checkDatabaseHealth.mockResolvedValue(false);

    const res = await request(app).get('/health');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.checks.database).toEqual({ status: 'error', latencyMs: expect.any(Number) });
  });

  it('still produces a response, never hangs, if the never-throws contract is violated', async () => {
    checkDatabaseHealth.mockRejectedValue(new Error('connection refused'));

    // getHealthReport's contract is that checkDatabaseHealth/
    // checkRedisHealth never reject — each catches internally in its real
    // implementation. This deliberately breaks that contract to prove the
    // request still resolves rather than hanging: with nothing else
    // catching it, the rejection propagates out of the async route
    // handler and Express 5's automatic async-rejection forwarding (see
    // asyncErrors.test.ts) carries it to the error middleware, producing
    // a normal sanitized 500 — not the health-report shape, since
    // getHealthReport itself never got to return.
    const res = await request(app).get('/health');

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
  });
});
