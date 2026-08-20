import * as Sentry from '@sentry/node';
import { Pool, type PoolConfig, type QueryResult, type QueryResultRow } from 'pg';
import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';

/**
 * Queries slower than this are logged as a warning, not just executed
 * silently. 200ms is well above normal latency for an indexed CRUD query
 * on this schema and well below "something is actually wrong" — a starting
 * point, not tuned against real production data yet.
 */
const SLOW_QUERY_THRESHOLD_MS = 200;

/**
 * max: 10 — this is a single long-running Express process, not a
 * serverless function (no per-invocation pool churn to worry about).
 * Local Postgres defaults to `max_connections: 100`, so 10 leaves headroom
 * for psql/other tooling and the separate worker process's own pool.
 * In production (Supabase), the Supavisor pooler multiplexes connections
 * server-side, so the app-side number just needs to be modest, not tuned
 * to Postgres's raw connection ceiling.
 *
 * connectionTimeoutMillis: 5000 — long enough to survive a brief network
 * blip to a remote database, short enough that a genuinely broken database
 * fails a request fast instead of hanging it indefinitely.
 *
 * idleTimeoutMillis: 30000 — balances not thrashing new connections under
 * bursty traffic against not holding connections open against Supavisor
 * longer than needed.
 */
const poolConfig: PoolConfig = {
  connectionString: config.DATABASE_URL,
  max: 10,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
};

// Local Docker Postgres has no SSL listener at all — passing an `ssl`
// object there breaks the connection, so it's only set in production.
// Supabase requires SSL, and its certificates chain to a publicly trusted
// CA, so `rejectUnauthorized: true` (the default when `ssl` is any
// truthy value) validates the connection against Node's normal trust
// store rather than disabling verification. Disabling verification
// (`rejectUnauthorized: false`) would accept *any* certificate, including
// one from a machine impersonating the database — not an acceptable
// tradeoff to make for convenience. Built as a conditionally-assigned key
// (not `ssl: undefined`) because tsconfig's `exactOptionalPropertyTypes`
// forbids assigning `undefined` into a key PoolConfig doesn't declare as
// accepting it.
if (config.NODE_ENV === 'production') {
  poolConfig.ssl = { rejectUnauthorized: true };
}

export const pool = new Pool(poolConfig);

// pg.Pool emits 'error' on an *idle* client — e.g. the database restarts
// and kills a connection nobody is actively using — completely
// independently of any query in flight. Without a listener, this is an
// unhandled 'error' event, which crashes the Node process outright.
pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected error on idle database client');
  Sentry.captureException(err);
});

/**
 * Runs a parameterized query through the shared pool, logging a warning if
 * it takes longer than SLOW_QUERY_THRESHOLD_MS. This is the only way
 * application code should talk to Postgres — always parameterized, never
 * string-concatenated.
 */
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
