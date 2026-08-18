import express from 'express';
import { config } from './config/index.js';
import { logger } from './lib/logger.js';
import { createErrorHandler } from './middleware/errorHandler.js';
import { notFoundHandler } from './middleware/notFoundHandler.js';
import { requestContext } from './middleware/requestContext.js';
import { corsMiddleware, securityHeaders } from './middleware/security.js';
import { authRouter } from './routes/auth.js';
import { healthRouter } from './routes/health.js';
import { linksRouter } from './routes/links.js';
import { redirectRouter } from './routes/redirect.js';
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

// An application setting, not middleware — unlike every app.use() below,
// where it's placed doesn't affect request-handling order (it's read
// per-request by Express's own req.ip getter, not executed as a step in
// the chain). Set once, here, right after construction: every IP-keyed
// piece of this app — this phase's rate limiters included — needs it to
// already be correct before it can run. See Notes.md, "Phase 10: Rate
// Limiting" / "trust proxy" for what breaks in each direction if this is
// wrong.
app.set('trust proxy', config.TRUST_PROXY);

// A direct-to-internet deployment (TRUST_PROXY=0) is legitimate — this is
// not an error. But in production behind an unconfigured load balancer,
// req.ip collapses to the LB's one address for every request, so every
// IP-keyed rate limiter below shares a single bucket across all users.
// The symptom (real users getting 429s they didn't individually earn)
// points nowhere near this cause, so it must be impossible to miss in
// startup logs. See Notes.md, "Phase 10: Rate Limiting" / "trust proxy"
// for the full writeup, and the Phase 15 deployment checklist.
if (config.NODE_ENV === 'production' && config.TRUST_PROXY === 0) {
  logger.warn(
    'TRUST_PROXY is 0 in production — if this deployment sits behind a load ' +
      "balancer or CDN, every request will appear to come from the proxy's " +
      'IP, and all IP-keyed rate limits (auth, unlock) will be shared across ' +
      'every real user instead of enforced per-user. Set TRUST_PROXY to the ' +
      'number of proxy hops in front of this process (1 for a single load ' +
      'balancer) if that applies here.',
  );
}

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
// Prefix-mounted, not flat like the two routers above — those each have a
// single route, so a full path costs nothing; authRouter has three routes
// today and future feature routers (link CRUD, etc.) will have more, so
// declaring paths relative to a mount prefix here is what scales.
app.use('/api/auth', authRouter);
app.use('/api/links', linksRouter);
// Flat-mounted, deliberately last among routes — /:shortCode only ever
// matches a single path segment (Express/path-to-regexp can't span a '/'
// with it), so it can only ever collide with other single-segment routes
// (/health today; a bare /api if ever requested) — never with
// /api/auth/* or /api/links/*, which win on their own more specific
// prefix regardless of mount order. RESERVED_SHORT_CODES (src/lib/
// shortCode.ts) stops someone from *registering* a link that impersonates
// a real single-segment path; this mount position is the independent
// second layer — it's what stops this router from *shadowing* that
// route's real behavior even if such a row could somehow exist. One is a
// write-time guarantee (no such row exists), the other a runtime one
// (even if it did, this router isn't reached first for /health).
app.use(redirectRouter);

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
