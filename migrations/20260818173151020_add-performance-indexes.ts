import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * This is the measurement-driven indexing pass the `links`/`clicks`
 * migrations' original comments forward-referenced as "Phase 12" — per the
 * project's actual phase numbering this landed as Phase 11. See Notes.md,
 * "Phase 11: Database Optimization" for the full methodology, the before/
 * after EXPLAIN ANALYZE plans each index below is justified by, and the
 * indexes that were considered and rejected.
 *
 * Every index here is added because a captured query plan against ~500
 * users / ~50,000 links / ~500,000 seeded rows (scripts/seed-bulk.ts, with
 * a deliberately non-uniform, Zipf-skewed click distribution) showed the
 * query it serves doing a full scan. No speculative indexes: anything
 * considered without that evidence is named and rejected in Notes.md
 * instead of added here "just in case."
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  // Serves listLinks' rows query (src/services/linkService.ts):
  //   SELECT ... FROM links WHERE user_id = $1
  //   ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3
  // user_id leftmost (the equality predicate) per the leftmost-prefix rule
  // — a query filtering on user_id alone (see the bare-filter proof query
  // in docs/performance/after.md) can still use this index, which is what
  // makes dropping the single-column links_user_id_index below safe rather
  // than merely convenient. created_at DESC, id DESC as the second/third
  // keys match the ORDER BY exactly (id DESC breaks ties the same way the
  // query does), so Postgres can walk the index in the exact order the
  // query needs instead of reading matching rows and sorting them
  // afterward.
  pgm.createIndex(
    'links',
    ['user_id', { name: 'created_at', sort: 'DESC' }, { name: 'id', sort: 'DESC' }],
    { name: 'links_user_id_created_at_id_index' },
  );

  // Serves sweepExpiredLinks (worker/processors/linkCleanupProcessor.ts):
  //   UPDATE links SET is_active = false, updated_at = now()
  //   WHERE is_active = true AND expires_at IS NOT NULL AND expires_at <= now()
  // Partial, not full: is_active is low-selectivity (most rows are active
  // at any given time), so a full index on it alone would rarely beat a
  // sequential scan. Keying on expires_at *within* the is_active = true
  // subset is what's actually selective, and rows drop out of this index
  // entirely the moment the sweep flips is_active to false — so the index
  // stays small relative to the always-shrinking "still active" population
  // rather than tracking the whole table's size.
  pgm.createIndex('links', 'expires_at', {
    name: 'links_expires_at_active_partial_index',
    where: 'is_active = true',
  });

  // Serves getLinkClickStats (src/services/linkService.ts), the per-link
  // daily click aggregation behind GET /api/links/:id/stats:
  //   SELECT date_trunc('day', c.clicked_at) AS day, count(*) AS clicks
  //   FROM clicks c JOIN links l ON l.id = c.link_id
  //   WHERE l.id = $1 AND l.user_id = $2 AND c.clicked_at >= $3
  //   GROUP BY day ORDER BY day
  // link_id leftmost (the JOIN's equality predicate) subsumes
  // clicks_link_id_index the same way the links composite above subsumes
  // links_user_id_index. clicked_at as the second key lets the bounded
  // ?days=N range scan (and the GROUP BY that follows) walk an
  // already-link_id-narrowed, clicked_at-ordered slice instead of a full
  // per-link scan of every click that link has ever recorded.
  pgm.createIndex('clicks', ['link_id', 'clicked_at'], {
    name: 'clicks_link_id_clicked_at_index',
  });

  // links_user_id_index and clicks_link_id_index (both created purely as
  // FK-support indexes, in the links/clicks table migrations) are dropped
  // here, not kept alongside the new composites. Both composites above
  // have the exact same leftmost column, so any query the single-column
  // index could serve — including the FK ON DELETE CASCADE lookup it
  // originally existed for — the composite serves too; see
  // docs/performance/after.md for the EXPLAIN ANALYZE proof this actually
  // holds (a bare `WHERE user_id = $1` filter, a bare `WHERE link_id = $1`
  // filter, and a `DELETE FROM users WHERE id = $1` cascade), rather than
  // just asserting it. Keeping both would mean two indexes maintained on
  // every INSERT/UPDATE where only one is ever used.
  pgm.dropIndex('links', 'user_id', { name: 'links_user_id_index' });
  pgm.dropIndex('clicks', 'link_id', { name: 'clicks_link_id_index' });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.createIndex('links', 'user_id', { name: 'links_user_id_index' });
  pgm.createIndex('clicks', 'link_id', { name: 'clicks_link_id_index' });

  pgm.dropIndex('clicks', ['link_id', 'clicked_at'], { name: 'clicks_link_id_clicked_at_index' });
  pgm.dropIndex('links', 'expires_at', { name: 'links_expires_at_active_partial_index' });
  pgm.dropIndex(
    'links',
    ['user_id', { name: 'created_at', sort: 'DESC' }, { name: 'id', sort: 'DESC' }],
    { name: 'links_user_id_created_at_id_index' },
  );
}
