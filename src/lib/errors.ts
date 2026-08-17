/**
 * Machine-readable error codes returned in the `error.code` field of every
 * error response. Kept separate from the HTTP status code because a client
 * should be able to branch on "what kind of error is this" without parsing
 * a message string — statuses are coarse (there's only one 404), codes can
 * be as specific as the API needs later without changing the status.
 */
export type ErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'GONE'
  | 'CONFLICT'
  | 'TOO_MANY_REQUESTS'
  | 'INTERNAL_ERROR';

/**
 * The one error type route handlers and services are expected to throw.
 * `isOperational` marks it as a deliberately-recognized, expected failure
 * (bad input, a missing resource, a conflicting write) as opposed to a bug
 * — the error middleware uses `instanceof AppError` as that exact
 * boundary: anything else that reaches it is treated as a programmer
 * error and sanitized before it reaches a client. See Notes.md, "Phase 3:
 * API Foundation" for the full operational-vs-programmer-error writeup.
 *
 * One class plus factory functions below, not a subclass per status code
 * — matches this codebase's existing style (EnvValidationError is a
 * single flat class, parseEnv is a plain function) and avoids seven
 * near-identical constructors that would only ever differ in status/code.
 *
 * `details` is a non-optional field defaulting to `null`, not
 * `details?: unknown`, because tsconfig's `exactOptionalPropertyTypes`
 * forbids assigning `undefined` into an optional key — the same
 * constraint already worked around in src/lib/logger.ts and
 * src/db/pool.ts by building objects conditionally instead.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly isOperational = true;
  readonly details: unknown;

  constructor(statusCode: number, code: ErrorCode, message: string, details: unknown = null) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function badRequest(message: string, details: unknown = null): AppError {
  return new AppError(400, 'BAD_REQUEST', message, details);
}

export function unauthorized(message = 'Unauthorized', details: unknown = null): AppError {
  return new AppError(401, 'UNAUTHORIZED', message, details);
}

export function forbidden(message = 'Forbidden', details: unknown = null): AppError {
  return new AppError(403, 'FORBIDDEN', message, details);
}

export function notFound(message = 'Not found', details: unknown = null): AppError {
  return new AppError(404, 'NOT_FOUND', message, details);
}

/**
 * 410, not 404: the server knows exactly what this resource was and is
 * deliberately declining to serve it, as opposed to 404's "no idea what
 * this could ever refer to." Used by the redirect route (Phase 7) for
 * links that are deactivated, expired, or click-exhausted — see
 * Notes.md, "Phase 7: The Public Redirect" for why all three are treated
 * as the same class of outcome even though each is technically
 * reversible via a PATCH.
 */
export function gone(message = 'Gone', details: unknown = null): AppError {
  return new AppError(410, 'GONE', message, details);
}

export function conflict(message: string, details: unknown = null): AppError {
  return new AppError(409, 'CONFLICT', message, details);
}

export function tooManyRequests(message = 'Too many requests', details: unknown = null): AppError {
  return new AppError(429, 'TOO_MANY_REQUESTS', message, details);
}

export function internal(message = 'Internal server error', details: unknown = null): AppError {
  return new AppError(500, 'INTERNAL_ERROR', message, details);
}
