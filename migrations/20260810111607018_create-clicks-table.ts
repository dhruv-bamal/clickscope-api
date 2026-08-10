import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('clicks', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    // Deleting a link deletes its click history — no orphaned analytics rows.
    link_id: {
      type: 'uuid',
      notNull: true,
      references: 'links',
      onDelete: 'CASCADE',
    },
    clicked_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
    // Nullable: not every request carries a referrer.
    referrer: {
      type: 'text',
    },
    // Nullable, stored raw — parsed later if needed, not normalized at
    // write time.
    user_agent: {
      type: 'text',
    },
    // Nullable: resolved later (e.g. via IP geolocation), not always
    // available at write time.
    country: {
      type: 'text',
    },
  });

  // Same FK-index gotcha as links.user_id: serves "list a link's clicks"
  // and keeps the ON DELETE CASCADE from links efficient instead of a full
  // table scan on every link delete.
  pgm.createIndex('clicks', 'link_id');

  // Deliberately NOT indexed here: clicked_at. No analytics route exists
  // yet in this phase — Phase 12 is the dedicated, measurement-driven
  // indexing pass. Considered, not overlooked.
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('clicks');
}
