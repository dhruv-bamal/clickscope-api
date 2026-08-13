import type { Logger } from 'pino';

/**
 * Augments Express's Request type with the fields Phase 3's middleware
 * attaches to every request. Global augmentation (not a custom Request
 * subtype) so every existing and future route handler sees these fields
 * without an explicit generic parameter or cast.
 *
 * Picked up automatically: tsconfig's `include: ["src/**\/*.ts"]` matches
 * any .ts file under src/, .d.ts included — no separate config entry
 * needed.
 */
declare global {
  namespace Express {
    interface Request {
      /** Per-request correlation ID — see src/middleware/requestContext.ts. */
      id: string;
      /** Pino logger pre-bound with { requestId: id } via logger.child(). */
      log: Logger;
      /**
       * Populated by src/middleware/validate.ts. Loosely typed (`unknown`
       * per key) at this global-augmentation level — route handlers narrow
       * with the same Zod schema the validator ran, e.g.
       * `schema.parse(req.validated?.body)` or a `z.infer<typeof schema>`
       * cast, once the first feature route needs it.
       */
      validated?: {
        body?: unknown;
        query?: unknown;
        params?: unknown;
      };
      /**
       * Populated by src/middleware/auth.ts on a successfully verified
       * request — the JWT's `sub` claim, nothing more. Route handlers that
       * need the full user row fetch it themselves (see authService's
       * getUserById); this middleware deliberately doesn't do that lookup
       * on every request.
       */
      userId?: string;
    }
  }
}

export {};
