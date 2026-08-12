import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodTypeAny } from 'zod';
import { badRequest } from '../lib/errors.js';

type ValidationTarget = 'body' | 'query' | 'params';

/**
 * Validates one part of the request against a Zod schema and, on success,
 * writes the parsed (typed, defaulted) value onto req.validated[target] —
 * not back onto req.body/req.query/req.params directly. That's not a
 * style choice: Express 5's req.query is a getter-only accessor with no
 * setter (node_modules/express/lib/request.js), so `req.query = {...}`
 * throws under this project's ESM/strict-mode execution. req.body and
 * req.params happen to be plain writable properties, but using one
 * mechanism for all three avoids an arbitrary asymmetry between them.
 *
 * Validation lives here, at the route boundary, rather than inside
 * services, because a service function should be callable from anywhere
 * — a route, a future BullMQ worker job, a test — none of which
 * necessarily have HTTP request shapes to validate against. Validating at
 * the boundary means services can trust plain, already-valid argument
 * types instead of every caller needing to construct request-shaped input
 * just to satisfy a Zod schema that only makes sense for HTTP.
 */
function makeValidator(schema: ZodTypeAny, target: ValidationTarget): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[target]);

    if (!result.success) {
      const details = result.error.issues.map((issue) => ({
        field: issue.path.join('.') || target,
        message: issue.message,
      }));
      next(badRequest('Validation failed', details));
      return;
    }

    req.validated ??= {};
    req.validated[target] = result.data as unknown;
    next();
  };
}

export const validateBody = (schema: ZodTypeAny): RequestHandler => makeValidator(schema, 'body');
export const validateQuery = (schema: ZodTypeAny): RequestHandler => makeValidator(schema, 'query');
export const validateParams = (schema: ZodTypeAny): RequestHandler =>
  makeValidator(schema, 'params');
