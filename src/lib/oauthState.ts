import { randomBytes } from 'node:crypto';
import { redis } from './redis.js';

// 10 minutes: long enough for a user to complete Google's consent screen,
// short enough that a leaked or intercepted callback URL stops being
// useful quickly.
const STATE_TTL_SECONDS = 600;
const STATE_KEY_PREFIX = 'oauth:state:';

/**
 * A cryptographically random, single-use token for the OAuth CSRF-
 * protection handshake (the `state` parameter). 32 random bytes, far more
 * than needed to make guessing infeasible — this isn't a length tuned for
 * minimalism, just "obviously unguessable."
 */
export function generateState(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Records `state` as valid for STATE_TTL_SECONDS. Must be called before
 * redirecting the browser to Google, so the callback has something to
 * check the returned state against.
 */
export async function storeState(state: string): Promise<void> {
  await redis.set(`${STATE_KEY_PREFIX}${state}`, '1', 'EX', STATE_TTL_SECONDS);
}

/**
 * Atomically checks-and-deletes `state` in a single Redis round trip
 * (GETDEL), so two requests racing on the same state value can't both
 * succeed — single-use is enforced by Redis itself, not by a separate
 * get-then-delete that would reopen the exact race this is meant to
 * close. Returns whether the state was valid (present and not already
 * consumed or expired).
 */
export async function consumeState(state: string): Promise<boolean> {
  const value = await redis.getdel(`${STATE_KEY_PREFIX}${state}`);
  return value !== null;
}
