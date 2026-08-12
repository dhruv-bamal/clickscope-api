import { checkDatabaseHealth } from '../db/health.js';
import { checkRedisHealth } from '../lib/redis.js';

interface DependencyStatus {
  status: 'ok' | 'error';
  latencyMs: number;
}

export interface HealthReport {
  status: 'ok' | 'degraded';
  checks: {
    database: DependencyStatus;
    redis: DependencyStatus;
  };
}

async function timed(check: () => Promise<boolean>): Promise<DependencyStatus> {
  const start = process.hrtime.bigint();
  const ok = await check();
  const latencyMs = Math.round(Number(process.hrtime.bigint() - start) / 1e6);
  return { status: ok ? 'ok' : 'error', latencyMs };
}

/**
 * Aggregates the readiness of every downstream dependency. Never throws:
 * checkDatabaseHealth and checkRedisHealth each already catch internally
 * and return a plain boolean, so there's nothing here that can reject —
 * a health check that crashes is worse than useless, since it can turn a
 * downstream blip into a full outage of the health endpoint itself.
 */
export async function getHealthReport(): Promise<HealthReport> {
  const [database, redis] = await Promise.all([
    timed(checkDatabaseHealth),
    timed(checkRedisHealth),
  ]);

  const allOk = database.status === 'ok' && redis.status === 'ok';

  return {
    status: allOk ? 'ok' : 'degraded',
    checks: { database, redis },
  };
}
