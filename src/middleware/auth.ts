import type { NextFunction, Request, Response } from 'express';
import { unauthorized } from '../lib/errors.js';
import { verifyToken } from '../services/tokenService.js';

const BEARER_PREFIX = 'Bearer ';

/**
 * Requires a valid Bearer token, attaching only the token's subject (a user
 * id) to req.userId — never the full user row. A route handler that needs
 * more than the id (e.g. GET /me) fetches it itself via
 * authService.getUserById. Doing a DB lookup here instead would mean every
 * authenticated request on every route pays a query just to populate a
 * field most handlers don't need; verifying the token's signature is
 * already enough to trust the id without touching the database.
 *
 * Missing/malformed/invalid/expired all produce the same 401 response body
 * — see Notes.md, Phase 4, for why expired vs. invalid is deliberately not
 * distinguishable to the client. The distinction is still logged (at warn,
 * with the request id) for operators; the token itself is never logged.
 */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.header('authorization');

  if (!header || !header.startsWith(BEARER_PREFIX)) {
    req.log.warn({ requestId: req.id }, 'Auth failed: missing or malformed Authorization header');
    next(unauthorized('Missing or invalid Authorization header'));
    return;
  }

  const token = header.slice(BEARER_PREFIX.length);
  const result = verifyToken(token);

  if (!result.ok) {
    req.log.warn({ requestId: req.id, reason: result.reason }, 'Auth failed: token rejected');
    next(unauthorized('Invalid or expired token'));
    return;
  }

  req.userId = result.payload.sub;
  next();
}
