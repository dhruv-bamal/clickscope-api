import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('users', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    email: {
      type: 'text',
      notNull: true,
    },
    // Nullable: OAuth-only users authenticate via their provider and never
    // set a local password.
    password_hash: {
      type: 'text',
    },
    oauth_provider: {
      type: 'text',
    },
    oauth_id: {
      type: 'text',
    },
    email_verified: {
      type: 'boolean',
      notNull: true,
      default: false,
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

  // Case-insensitive email uniqueness. A plain UNIQUE(email) would treat
  // "foo@bar.com" and "Foo@Bar.com" as distinct rows; this functional index
  // enforces uniqueness on the lowercased value instead, without pulling in
  // the citext extension (whose implicit case-insensitive comparisons
  // everywhere are more surface than uniqueness alone needs).
  pgm.createIndex('users', 'lower(email)', {
    unique: true,
    name: 'users_email_lower_unique_idx',
  });

  // Plain UNIQUE on (oauth_provider, oauth_id) is sufficient on its own —
  // Postgres treats NULL <> NULL in uniqueness checks, so any number of
  // password-only users (both columns NULL) coexist fine. The constraint
  // only ever fires when both columns are non-null, exactly the OAuth
  // identity case it protects. No partial index needed.
  pgm.addConstraint('users', 'users_oauth_identity_unique', {
    unique: ['oauth_provider', 'oauth_id'],
  });

  // A user authenticates via exactly one method: a local password, or an
  // OAuth identity — never both, never neither. This is a true XOR, not
  // just "at least one," since a row with both set has no defined
  // precedence rule in the application.
  pgm.addConstraint('users', 'users_password_xor_oauth_check', {
    check: `
      (password_hash IS NOT NULL AND oauth_provider IS NULL AND oauth_id IS NULL)
      OR
      (password_hash IS NULL AND oauth_provider IS NOT NULL AND oauth_id IS NOT NULL)
    `,
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('users');
}
