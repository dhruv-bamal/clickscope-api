import { query } from './pool.js';
import { logger } from '../lib/logger.js';

/**
 * Verifies real database connectivity by running a trivial query, not just
 * checking that the pool object exists — a pool can be constructed and
 * "truthy" while the database itself is completely unreachable. No route
 * is wired to this yet; Phase 3 adds the /health endpoint that calls it.
 */
export async function checkDatabaseHealth(): Promise<boolean> {
  try {
    await query('SELECT 1');
    return true;
  } catch (err) {
    logger.error({ err }, 'Database health check failed');
    return false;
  }
}
