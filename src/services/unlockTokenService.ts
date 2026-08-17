import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';

const UNLOCK_TOKEN_TTL = '30m';
const UNLOCK_TOKEN_TYPE = 'link_unlock';

/**
 * A grant proving "the bearer supplied the correct password for one
 * specific link" — deliberately not built on tokenService.ts's user-session
 * JWTs. A visitor unlocking a password-protected link is not one of our
 * users: there's no `users` row to name as `sub`, a 7-day session lifetime
 * makes no sense for "you proved you know one link's password five minutes
 * ago," and conflating the two would mean a login session and a one-link
 * grant are represented by the same claim shape for two unrelated subjects.
 * See Notes.md, "Phase 7: The Public Redirect" / "Per-link passwords as a
 * distinct auth problem."
 */
interface UnlockTokenPayload {
  linkId: string;
  typ: typeof UNLOCK_TOKEN_TYPE;
}

/**
 * Signs a short-lived grant naming one link's real database id — not its
 * short code (mutable-ish, and not the actual foreign-key identity) and
 * not a user id (the visitor is anonymous).
 *
 * Reuses config.JWT_SECRET rather than adding a second secret: forging
 * either kind of token requires the same leaked secret either way, so a
 * second secret buys no extra protection against that scenario. The `typ`
 * discriminator keeps the two token *shapes* non-interchangeable even
 * though they share a signing key — verifyUnlockToken below rejects
 * anything without it, so a real user session token can never be replayed
 * here even though jwt.verify() would happily validate its signature.
 */
export function signUnlockToken(linkId: string): string {
  return jwt.sign({ linkId, typ: UNLOCK_TOKEN_TYPE } satisfies UnlockTokenPayload, config.JWT_SECRET, {
    expiresIn: UNLOCK_TOKEN_TTL,
  });
}

export type VerifyUnlockTokenResult = { ok: true; linkId: string } | { ok: false };

/**
 * Verifies signature, expiry, and the `typ` discriminator, returning the
 * linkId the grant was issued for. This function only proves "a
 * validly-signed, unexpired unlock grant for *some* link" — the CRITICAL
 * check is the caller comparing the returned linkId against the specific
 * link actually being requested (src/routes/redirect.ts). Without that
 * comparison, unlocking any one password-protected link would grant
 * access to every password-protected link.
 */
export function verifyUnlockToken(token: string): VerifyUnlockTokenResult {
  try {
    const payload = jwt.verify(token, config.JWT_SECRET) as jwt.JwtPayload;
    if (payload.typ !== UNLOCK_TOKEN_TYPE || typeof payload.linkId !== 'string') {
      return { ok: false };
    }
    return { ok: true, linkId: payload.linkId };
  } catch {
    return { ok: false };
  }
}
