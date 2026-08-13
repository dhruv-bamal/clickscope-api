import bcrypt from 'bcryptjs';
import { config } from '../config/index.js';

/**
 * Hashes a plaintext password with bcrypt at the configured cost factor.
 * bcrypt generates and embeds a fresh random salt in the returned hash
 * string itself (format: $2b$<cost>$<22-char salt><31-char hash>) — no
 * separate salt column is needed anywhere in the schema.
 */
export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, config.BCRYPT_COST);
}

/**
 * Verifies a plaintext password against a bcrypt hash. compare() re-derives
 * the salt from the hash string itself (it's stored in the hash's first
 * segments), so it works without a separate salt argument despite the salt
 * being random per call to hashPassword.
 */
export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/**
 * A fixed bcrypt hash of an arbitrary, never-used-elsewhere password,
 * computed once at module load — not per request. authService.login calls
 * verifyPassword against this (and discards the result) on the "no such
 * user" path, so that path takes roughly the same time as a real failed
 * login, closing the timing side-channel that would otherwise let an
 * attacker distinguish "wrong password" from "no such account" by response
 * latency alone.
 *
 * Computed against config.BCRYPT_COST — not a hardcoded cost — because a
 * bcrypt hash string embeds its own cost factor, and compare()'s runtime is
 * dominated by that embedded cost. A dummy hash baked at a stale/different
 * cost would still leak a small but measurable timing difference against
 * real per-user hashes, reopening a narrower version of the same attack.
 */
export const DUMMY_PASSWORD_HASH: string = bcrypt.hashSync(
  'dummy-password-for-timing-safety-only',
  config.BCRYPT_COST,
);

/** Burns one bcrypt comparison of matching cost; the result is never meaningful. */
export async function verifyAgainstDummyHash(plain: string): Promise<boolean> {
  return verifyPassword(plain, DUMMY_PASSWORD_HASH);
}
