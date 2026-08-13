import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';

export interface TokenPayload {
  sub: string;
  iat: number;
  exp: number;
}

/**
 * Signs a JWT identifying userId as the subject. Passing `subject` (rather
 * than putting `sub` in the payload object by hand) lets jsonwebtoken own
 * `sub`/`iat`/`exp` entirely — no risk of the payload and options
 * disagreeing about the subject, and `iat`/`exp` are always derived from
 * the real signing time, not caller-supplied.
 */
export function signToken(userId: string): string {
  return jwt.sign({}, config.JWT_SECRET, {
    subject: userId,
    // @types/jsonwebtoken narrows expiresIn to a template-literal union
    // (via the `ms` package) rather than plain string. config.JWT_EXPIRES_IN
    // is a Zod-validated string, not a literal, so it doesn't structurally
    // match that union — jsonwebtoken itself validates and throws at call
    // time on a genuinely malformed value, so this cast is safe. NonNullable
    // strips the `undefined` the optional-property type would otherwise
    // carry, which exactOptionalPropertyTypes forbids assigning explicitly.
    expiresIn: config.JWT_EXPIRES_IN as NonNullable<jwt.SignOptions['expiresIn']>,
  });
}

export type VerifyTokenResult =
  { ok: true; payload: TokenPayload } | { ok: false; reason: 'expired' | 'invalid' };

/**
 * Verifies a JWT's signature and expiry. Returns a discriminated union
 * instead of throwing: a malformed or expired token on an authenticated
 * request is an expected outcome (matching this codebase's existing
 * pattern of Zod's safeParse over parse+catch), not a programmer error —
 * callers branch on `ok` without try/catch.
 *
 * jwt.verify recomputes the HMAC signature over the token's header+payload
 * using JWT_SECRET and compares it to the signature segment. Any change to
 * either the payload or the signature — even a single flipped bit —
 * produces a different recomputed signature, so tampering is detected by
 * mismatch, not by inspecting the payload's content.
 */
export function verifyToken(token: string): VerifyTokenResult {
  try {
    const payload = jwt.verify(token, config.JWT_SECRET) as TokenPayload;
    return { ok: true, payload };
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      return { ok: false, reason: 'expired' };
    }
    // Covers JsonWebTokenError (bad signature, malformed token, wrong
    // algorithm) and NotBeforeError alike — the client-facing outcome for
    // all of them is identical ("invalid"), only server-side logging cares
    // about the distinction from 'expired'.
    return { ok: false, reason: 'invalid' };
  }
}
