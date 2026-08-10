import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('links', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    // Every link belongs to exactly one user; cascade matches "delete my
    // account removes my links."
    user_id: {
      type: 'uuid',
      notNull: true,
      references: 'users',
      onDelete: 'CASCADE',
    },
    short_code: {
      type: 'text',
      notNull: true,
      unique: true,
    },
    destination_url: {
      type: 'text',
      notNull: true,
    },
    // Nullable: most links have no per-link password gate.
    password_hash: {
      type: 'text',
    },
    // Nullable: null means the link never expires.
    expires_at: {
      type: 'timestamptz',
    },
    // Nullable: null means unlimited clicks.
    max_clicks: {
      type: 'integer',
    },
    // Denormalized counter, incremented by future click-tracking logic.
    click_count: {
      type: 'integer',
      notNull: true,
      default: 0,
    },
    is_active: {
      type: 'boolean',
      notNull: true,
      default: true,
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
    updated_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  // Postgres does not automatically index foreign key columns. This index
  // serves "list a user's links" (WHERE user_id = $1 — every future
  // GET /links needs this) and keeps the ON DELETE CASCADE from users
  // efficient instead of a full table scan on every user delete.
  pgm.createIndex('links', 'user_id');

  pgm.addConstraint('links', 'links_max_clicks_positive_check', {
    check: 'max_clicks IS NULL OR max_clicks > 0',
  });
  pgm.addConstraint('links', 'links_click_count_non_negative_check', {
    check: 'click_count >= 0',
  });

  // Deliberately NOT indexed here: expires_at, is_active. No route reads
  // "find expired/inactive links" yet in this phase — Phase 12 is the
  // dedicated, measurement-driven indexing pass. Considered, not overlooked.
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('links');
}
