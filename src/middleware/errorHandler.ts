import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Config } from '../config/env.js';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

/**
 * Returns the app's error-handling middleware. A factory that takes
 * nodeEnv as a parameter — rather than middleware that reads the config
 * singleton internally — so "programmer errors don't leak in production"
 * is testable via plain dependency injection: a test can call
 * createErrorHandler('production') directly against a throwaway app,
 * instead of fighting the already-parsed, import-time config singleton
 * (which can't cleanly be re-parsed as 'production' mid-suite while other
 * tests still need 'test').
 *
 * Express identifies error middleware by function arity: exactly 4
 * declared parameters (err, req, res, next) marks a function as an error
 * handler, only ever invoked when something calls next(err) or an async
 * handler's returned promise rejects. Any other arity is treated as
 * regular middleware and never receives errors — the unused `_next`
 * parameter below can't be dropped even though it's never called,
 * because removing it would drop the arity to 3 and this function would
 * silently stop being recognized as an error handler at all (no warning;
 * the app would just fall through to Express's own default HTML error
 * page). Registration position matters independently of arity too:
 * Express matches middleware top-to-bottom and only jumps to error
 * middleware once next(err) fires, so this must be registered strictly
 * after every route and after the 404 handler — see src/app.ts.
 */
export function createErrorHandler(nodeEnv: Config['NODE_ENV']) {
  return function errorHandler(
    err: unknown,
    req: Request,
    res: Response,
    _next: NextFunction,
  ): void {
    const isAppError = err instanceof AppError;
    const statusCode = isAppError ? err.statusCode : 500;
    const code = isAppError ? err.code : 'INTERNAL_ERROR';
    const isProduction = nodeEnv === 'production';

    // Operational errors (AppError) are deliberately-thrown and their
    // message is always safe to show a client. Anything else reaching
    // here is a programmer error — its real message is only shown
    // outside production; in production the client gets a generic
    // message while the server-side log below still gets full detail.
    const clientMessage = isAppError
      ? err.message
      : isProduction
        ? 'Internal Server Error'
        : err instanceof Error
          ? err.message
          : 'Internal Server Error';

    const log = req.log ?? logger;
    const requestId = req.id ?? randomUUID();

    if (statusCode >= 500) {
      log.error(
        { err, requestId, statusCode, isOperational: isAppError },
        'Request failed with server error',
      );
    } else {
      log.warn(
        { err, requestId, statusCode, isOperational: isAppError },
        'Request failed with client error',
      );
    }

    res.status(statusCode).json({
      error: {
        code,
        message: clientMessage,
        requestId,
        ...(isAppError && err.details !== null ? { details: err.details } : {}),
      },
    });
  };
}
