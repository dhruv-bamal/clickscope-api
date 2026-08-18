import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Idempotency key for the click-recording worker (Phase 9): the producer
  // (redirect.ts) generates this once per enqueue and reuses it as both
  // the BullMQ jobId and this column's value, so a duplicate-processed job
  // — a stalled worker lock, a retry after a lost ack, a crash mid-job —
  // has its INSERT become a harmless no-op via ON CONFLICT (job_id) DO
  // NOTHING instead of a second row. See worker/processors/clickProcessor.ts
  // and Notes.md, "Phase 9: Background Jobs" for the full writeup.
  //
  // Deliberately a separate column from `id`, not a reuse of the primary
  // key itself — `id` stays server-generated everywhere else in this
  // codebase, and conflating "row identity" with "idempotency key" would
  // be a quiet, easy-to-forget exception to that.
  //
  // Defaulted to gen_random_uuid() purely so this ALTER TABLE never
  // conflicts with any pre-existing rows (each gets its own distinct
  // default at backfill time) — every row written going forward supplies
  // its own value explicitly, overriding the default.
  pgm.addColumn('clicks', {
    job_id: {
      type: 'uuid',
      notNull: true,
      default: pgm.func('gen_random_uuid()'),
    },
  });

  // No separate index beyond what this constraint's own implicit unique
  // index already provides — nothing queries by job_id except the
  // worker's ON CONFLICT target itself.
  pgm.addConstraint('clicks', 'clicks_job_id_unique', {
    unique: 'job_id',
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint('clicks', 'clicks_job_id_unique');
  pgm.dropColumn('clicks', 'job_id');
}
