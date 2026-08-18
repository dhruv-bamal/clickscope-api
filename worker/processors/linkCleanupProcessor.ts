import { query } from '../db/pool.js';
import { logger } from '../logger.js';

/**
 * The scheduled half of expiry — Phase 7 implemented lazy expiry only
 * (deadStateError in src/routes/redirect.ts checks expires_at on read, so
 * an expired link still 410s correctly even if this sweep has never run
 * against it). This sweep is what actually reclaims the row's "active"
 * status in storage, for links nobody ever clicks again and would
 * otherwise sit in the table forever looking live. See Notes.md, "Phase 7:
 * The Public Redirect" / "Lazy vs. scheduled expiry" and "Phase 9:
 * Background Jobs" for why production usually runs both.
 *
 * Scoped to expires_at only, deliberately never max_clicks. Flipping
 * is_active for a link that's currently dead *only* because it's
 * click-exhausted would change which branch of deadStateError fires next —
 * "This link has been deactivated" instead of "This link has reached its
 * click limit" — an observable message-text change outside what this
 * sweep is meant to affect.
 *
 * A single UPDATE, no transaction needed — one statement is already
 * atomic under Postgres's MVCC, same reasoning Phase 7 already applied to
 * the click_count increment. Naturally idempotent: a row that's already
 * is_active = false simply doesn't match the WHERE clause on a later run,
 * and Postgres's row-level locking serializes genuinely concurrent runs
 * against the same rows — this is the actual correctness backstop behind
 * "safe to run on every worker instance," independent of the
 * upsertJobScheduler dedup in worker/scheduler.ts. See Notes.md, "Phase 9:
 * Background Jobs" / "Scheduled cleanup" for the full writeup.
 */
export async function sweepExpiredLinks(): Promise<{ deactivated: number }> {
  const start = process.hrtime.bigint();

  const result = await query(
    `UPDATE links
     SET is_active = false, updated_at = now()
     WHERE is_active = true
       AND expires_at IS NOT NULL
       AND expires_at <= now()`,
  );

  const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
  const deactivated = result.rowCount ?? 0;

  logger.info({ deactivated, durationMs }, 'Expired-link sweep completed');

  return { deactivated };
}
