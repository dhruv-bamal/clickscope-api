import type { NextFunction, Request, Response } from 'express';
import { notFound } from '../lib/errors.js';

/**
 * Registered in src/app.ts as `app.use(notFoundHandler)` — deliberately
 * with NO path argument. Express 5 bundles path-to-regexp@8, which
 * rejects a bare '*' at route-registration time (confirmed directly:
 * `app.use('*', fn)` throws "Missing parameter name at index 1: *" on
 * this version). A path-less app.use matches every method/path with no
 * route-pattern parsing involved at all, which sidesteps that entirely
 * and isn't tied to path-to-regexp's wildcard syntax in the first place.
 *
 * Forwarding to next(notFound(...)) — rather than writing the 404
 * response directly — routes unmatched paths through the same
 * centralized JSON error formatting every other error uses, instead of a
 * one-off response shape that would drift from it.
 */
export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(notFound(`Route not found: ${req.method} ${req.originalUrl}`));
}
