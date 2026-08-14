import { DatabaseError } from 'pg';
import { query } from '../db/pool.js';
import { badRequest, conflict, unauthorized } from '../lib/errors.js';
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
 * Finds an existing OAuth user or creates one. Looked up by
 * (oauth_provider, oauth_id) FIRST — never by email — because the
 * provider's subject id is the stable identity key; a user's email can
 * change on Google's side (or be reused by someone else after being
 * freed), but their `sub` claim never does. Keying on email instead would
 * mean a user who changes their Google email either gets treated as a
 * brand-new signup (losing their account) or, worse, silently merges into
 * whatever account currently holds that email.
 *
 * If no OAuth match exists, the email is checked against existing
 * accounts: a match there is necessarily a *password* account (an OAuth
 * match would already have returned above), so this deliberately does
 * NOT auto-link — it throws 409 rather than attaching a Google identity
 * to somebody else's password account. See Notes.md Phase 5 for the
 * account-takeover reasoning this policy exists to prevent.
 *
 * New rows get password_hash omitted (stays NULL) and oauth_provider/
 * oauth_id set — satisfying users_password_xor_oauth_check by
 * construction, the same way signup satisfies it by omitting the oauth
 * columns.
 *
 * Requires emailVerified === true, checked before anything else runs
 * (including the returning-user lookup). Without this, an attacker could
 * sign in with a Google account whose email Google itself hasn't
 * verified — e.g. an address added but never confirmed — and either
 * squat on someone else's email (permanently blocking the real owner
 * from ever signing up with it, since the unique index on lower(email)
 * would then see it as taken) or, on a later login, have their own
 * genuine account collide with that squatted row. Rejecting unverified
 * emails outright closes this before any row is read or written.
 */
export async function findOrCreateOAuthUser(
  provider: string,
  oauthId: string,
  email: string,
  emailVerified: boolean,
): Promise<{ user: AuthUser; token: string }> {
  if (!emailVerified) {
    throw badRequest('Google account email is not verified');
  }

  const existingOAuth = await query<UserRow>(
    `SELECT id, email, email_verified, created_at, updated_at
     FROM users
     WHERE oauth_provider = $1 AND oauth_id = $2`,
    [provider, oauthId],
  );
  const oauthRow = existingOAuth.rows[0];
  if (oauthRow) {
    const user = toAuthUser(oauthRow);
    return { user, token: signToken(user.id) };
  }

  const existingPassword = await query<{ id: string }>(
    'SELECT id FROM users WHERE lower(email) = lower($1)',
    [email],
  );
  if (existingPassword.rows[0]) {
    throw conflict('An account with this email already exists — sign in with your password');
  }

  let row: UserRow;
  try {
    const result = await query<UserRow>(
      `INSERT INTO users (email, oauth_provider, oauth_id, email_verified)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, email_verified, created_at, updated_at`,
      [email, provider, oauthId, emailVerified],
    );
    const inserted = result.rows[0];
    if (!inserted) {
      throw new Error('Insert returned no row');
    }
    row = inserted;
  } catch (err) {
    if (err instanceof DatabaseError && err.code === UNIQUE_VIOLATION) {
      // Two concurrent logins for the SAME Google account racing here are
      // the same legitimate action happening twice (e.g. a double-clicked
      // "Sign in with Google" button) — not a real conflict, unlike
      // signup's race, where two concurrent signups for one email really
      // are competing for it. Re-fetch and return the winner's row rather
      // than converting to a 409.
      const retry = await query<UserRow>(
        `SELECT id, email, email_verified, created_at, updated_at
         FROM users
         WHERE oauth_provider = $1 AND oauth_id = $2`,
        [provider, oauthId],
      );
      const retryRow = retry.rows[0];
      if (retryRow) {
        const user = toAuthUser(retryRow);
        return { user, token: signToken(user.id) };
      }
      // The race was on the email-lowercase index instead (a password
      // signup won concurrently) — a genuine conflict.
      throw conflict('An account with this email already exists — sign in with your password');
    }
    throw err;
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
