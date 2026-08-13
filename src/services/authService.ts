import { DatabaseError } from 'pg';
import { query } from '../db/pool.js';
import { conflict, unauthorized } from '../lib/errors.js';
import { hashPassword, verifyAgainstDummyHash, verifyPassword } from './passwordService.js';
import { signToken } from './tokenService.js';

/** Postgres error code for a unique-constraint violation. */
const UNIQUE_VIOLATION = '23505';

/** Every login attempt against a missing or wrong account gets this exact message — never a hint about which one it was. */
const INVALID_CREDENTIALS_MESSAGE = 'Invalid email or password';

/**
 * The shape returned to callers. Structurally cannot contain password_hash:
 * every query below explicitly lists columns (never SELECT *), and this
 * interface has no field for it — nothing downstream can reference
 * password_hash even by typo.
 */
export interface AuthUser {
  id: string;
  email: string;
  emailVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface UserRow {
  id: string;
  email: string;
  email_verified: boolean;
  created_at: Date;
  updated_at: Date;
}

function toAuthUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    email: row.email,
    emailVerified: row.email_verified,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Creates a local-password user. Rejects with 409 if the email is already
 * taken (case-insensitively — the schema's uniqueness lives on
 * lower(email), so lookups and the conflict check both match on that, not
 * the raw column).
 *
 * The pre-check below has a TOCTOU race: two concurrent signups for the
 * same email can both pass it before either INSERTs. The functional unique
 * index users_email_lower_unique_idx is the real correctness guarantee —
 * the INSERT is wrapped in a catch for Postgres error code 23505
 * (unique_violation) as a backstop, converting a race loss into the same
 * 409 a sequential duplicate signup would get, rather than a raw 500.
 */
export async function signup(
  email: string,
  password: string,
): Promise<{ user: AuthUser; token: string }> {
  const existing = await query<{ id: string }>(
    'SELECT id FROM users WHERE lower(email) = lower($1)',
    [email],
  );
  if (existing.rows[0]) {
    throw conflict('An account with this email already exists');
  }

  const passwordHash = await hashPassword(password);

  let row: UserRow;
  try {
    const result = await query<UserRow>(
      `INSERT INTO users (email, password_hash)
       VALUES ($1, $2)
       RETURNING id, email, email_verified, created_at, updated_at`,
      [email, passwordHash],
    );
    const inserted = result.rows[0];
    if (!inserted) {
      throw new Error('Insert returned no row');
    }
    row = inserted;
  } catch (err) {
    if (err instanceof DatabaseError && err.code === UNIQUE_VIOLATION) {
      throw conflict('An account with this email already exists');
    }
    throw err;
  }

  const user = toAuthUser(row);
  return { user, token: signToken(user.id) };
}

/**
 * Authenticates by email + password. Both "no such user" and "wrong
 * password" throw the identical 401 with the identical message — a caller
 * cannot distinguish "this email isn't registered" from "you mistyped the
 * password" from the response alone (user enumeration prevention).
 *
 * When no matching row exists (or the row is OAuth-only, password_hash
 * NULL), verifyAgainstDummyHash still runs a bcrypt comparison of matching
 * cost before throwing, so that branch takes comparable time to a real
 * failed password check — see passwordService.ts for why this closes the
 * timing side-channel.
 */
export async function login(
  email: string,
  password: string,
): Promise<{ user: AuthUser; token: string }> {
  const result = await query<UserRow & { password_hash: string | null }>(
    `SELECT id, email, email_verified, created_at, updated_at, password_hash
     FROM users
     WHERE lower(email) = lower($1)`,
    [email],
  );
  const row = result.rows[0];

  if (!row || row.password_hash === null) {
    await verifyAgainstDummyHash(password);
    throw unauthorized(INVALID_CREDENTIALS_MESSAGE);
  }

  const passwordMatches = await verifyPassword(password, row.password_hash);
  if (!passwordMatches) {
    throw unauthorized(INVALID_CREDENTIALS_MESSAGE);
  }

  const user = toAuthUser(row);
  return { user, token: signToken(user.id) };
}

/**
 * Fetches the full user by id. requireAuth only attaches req.userId (see
 * src/middleware/auth.ts for why) — route handlers like GET /me call this
 * themselves when they need more than the id.
 */
export async function getUserById(id: string): Promise<AuthUser | null> {
  const result = await query<UserRow>(
    'SELECT id, email, email_verified, created_at, updated_at FROM users WHERE id = $1',
    [id],
  );
  const row = result.rows[0];
  return row ? toAuthUser(row) : null;
}
