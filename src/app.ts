import express from 'express';
import { config } from './config/index.js';
import { createErrorHandler } from './middleware/errorHandler.js';
import { notFoundHandler } from './middleware/notFoundHandler.js';
import { requestContext } from './middleware/requestContext.js';
import { corsMiddleware, securityHeaders } from './middleware/security.js';
import { healthRouter } from './routes/health.js';
import { rootRouter } from './routes/root.js';

/**
 * The composition root: builds and exports the Express app without ever
 * calling .listen(). src/server.ts is the only module that imports this
 * one and starts listening — that split means tests (and supertest) can
 * import `app` directly and issue requests against it in-process, without
 * opening a real port or triggering the "start the real server" side
 * effects that used to live inline in server.ts.
 *
 * A singleton export, not a createApp() factory, matching this codebase's
 * existing style for module-level singletons (config, logger, pool) —
 * nothing here needs more than one differently-configured app instance
 * within a process, and Vitest's vi.mock intercepts at the module level
 * regardless, so a factory wouldn't buy any extra testability.
 */
export const app = express();

// Registration order is semantics, not style — each stage below can only
// rely on what ran before it, and Express only routes an error into the
// error handler once something after it calls next(err), so anything
// registered after the error handler would never see one.
//
// 1. requestContext first: every later stage — including a body-parse
//    failure in step 4, before any route is even reached — gets a
//    request ID and a logged start/completion line.
app.use(requestContext);

// 2. Security headers before anything else touches the response, so
//    every response (success, 404, error) carries them, not just
//    "happy path" ones.
app.use(securityHeaders);

// 3. CORS before body parsing and routes — preflight OPTIONS requests
//    never reach a route handler at all, so this has to run first.
app.use(corsMiddleware);

// 4. JSON body parsing, after security/CORS (nothing about parsing the
//    body depends on those), before any route that reads req.body.
app.use(express.json());

// 5. Routes. Future feature routers mount here too, after parsing and
//    security, before the catch-all.
app.use(rootRouter);
app.use(healthRouter);

// 6. Catch-all 404, after every real route (so it only fires for
//    genuinely unmatched paths) and before the error handler (so an
//    unmatched route flows through the same centralized JSON error
//    formatting instead of Express's default HTML 404). Registered with
//    no path argument — Express 5 bundles path-to-regexp@8, which
//    rejects a bare '*' at registration time (see notFoundHandler.ts).
app.use(notFoundHandler);

// 7. Error handler, strictly last. Express identifies it by its 4-arg
//    signature (err, req, res, next) — anything registered after this
//    point is simply never in the call chain for an error, since Express
//    matches middleware top-to-bottom and only jumps here once next(err)
//    fires.
app.use(createErrorHandler(config.NODE_ENV));
