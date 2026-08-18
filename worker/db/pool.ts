import { Pool, type PoolClient, type PoolConfig, type QueryResult, type QueryResultRow } from 'pg';
import { workerConfig } from '../config.js';
import { logger } from '../logger.js';

const SLOW_QUERY_THRESHOLD_MS = 200;

/**
 * The worker's own Pool, not the API's singleton — a different process,
 * and src/db/pool.ts's own doc comment already earmarks headroom for
 * exactly this ("10 leaves headroom for psql/other tooling and the
 * separate worker process's own pool").
 *
 * max: 10 — mirrors the API pool's number and reasoning. Combined with
 * `Worker` concurrency: 5 (see worker/index.ts), each concurrently-
 * processing job holds one connection for the duration of its transaction,
 * leaving comfortable headroom for the cleanup job's own connection use
 * and any transient retry overlap without needing to reason about
 * contention. See Notes.md, "Phase 9: Background Jobs" for the full
 * concurrency-sizing writeup.
 */
const poolConfig: PoolConfig = {
  connectionString: workerConfig.DATABASE_URL,
  max: 10,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
};

if (workerConfig.NODE_ENV === 'production') {
  poolConfig.ssl = { rejectUnauthorized: true };
}

export const pool = new Pool(poolConfig);

pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected error on idle worker database client');
});

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  const start = Date.now();
  const result = await pool.query<T>(text, params);
  const durationMs = Date.now() - start;

  if (durationMs > SLOW_QUERY_THRESHOLD_MS) {
    logger.warn({ text, durationMs }, 'Slow query');
  }

  return result;
}

/**
 * Runs `fn` inside a BEGIN/COMMIT transaction on one dedicated connection,
 * ROLLBACK-ing on any thrown error. This is the exact helper Phase 7 built,
 * benchmarked (~0.75ms vs ~0.5ms for the click write — roughly 1.5x, from
 * two extra network round trips), and deliberately deleted from
 * src/db/pool.ts as unused once that decision landed on "not worth it on
 * the hottest path in the system."
 *
 * It's reintroduced here, in the worker only, because the constraint that
 * drove that earlier rejection — this being the hottest path in the system
 * — doesn't apply to a background job. The worker's idempotent click-write
 * (see worker/processors/clickProcessor.ts) genuinely needs the atomicity
 * a transaction provides: the INSERT ... ON CONFLICT DO NOTHING and the
 * conditional click_count UPDATE must both commit or both roll back, or a
 * crash between them could permanently skip an increment for a click that
 * was, in fact, successfully recorded. See Notes.md, "Phase 9: Background
 * Jobs" for the full writeup of why this is the opposite conclusion from
 * Phase 7's, reached via the same cost/benefit reasoning.
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
