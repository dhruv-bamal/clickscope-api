import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { logger } from '../lib/logger.js';

const MAX_INBOUND_ID_LENGTH = 200;

/**
 * Returns the matched route's PATTERN (e.g. "/api/links/:id"), not the
 * raw path (e.g. "/api/links/3f9a1e2c-..."). Aggregating request logs by
 * raw path is useless once any path segment is a UUID or short code:
 * every request becomes its own one-sample "route," so there's no way to
 * compute "p95 latency of GET /api/links/:id" from the log stream at
 * all — only "p95 latency of this one specific UUID," which is
 * meaningless.
 *
 * req.route is only populated once Express has matched a route — it
 * does not exist yet when requestContext runs (registered first, before
 * routing), but is reliably set by the time res.on('finish') fires,
 * since routing (and the handler it dispatches to) has already
 * completed by then. req.baseUrl holds the router's mount prefix (e.g.
 * "/api/links" for a prefix-mounted router, "" for a flat-mounted one
 * like redirectRouter), and req.route.path holds the route's own path
 * relative to that mount — concatenating them reconstructs the full
 * pattern regardless of mount style.
 *
 * Requests that never match any route (a genuine 404, or an error
 * thrown in pre-routing middleware like express.json()'s parse failure)
 * fall back to the fixed literal 'unmatched' — still bounded
 * cardinality, and not attacker-controlled the way echoing req.path
 * back would be.
 */
function getRoutePattern(req: Request): string {
  if (!req.route) return 'unmatched';
  const pattern = `${req.baseUrl}${req.route.path as string}`;
  return pattern || '/';
}

/**
 * Stamps every request with a correlation ID, a request-scoped child
 * logger, and start/completion log lines. Registered first in src/app.ts
 * so every later stage of the pipeline — including a body-parse failure
 * before any route is reached — has req.id/req.log available and gets
 * logged under the same ID.
 *
 * Correlation IDs matter because production log lines from concurrent
 * requests interleave in the aggregate log stream; without a shared ID
 * stamped on every line a single request produces, there's no way to
 * reconstruct "everything that happened for this one failing request"
 * except grepping by approximate timestamp. Accepting an inbound
 * X-Request-Id (rather than always generating a fresh one) also lets the
 * ID be set upstream — a load balancer, gateway, or the frontend itself —
 * and stay stable across service boundaries, not just within this
 * process.
 */
export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const inbound = req.header('x-request-id');
  // Length-capped: an unbounded, attacker-controlled header value flowing
  // straight into structured logs is a cheap log-injection/log-bloat
  // vector otherwise.
  const id =
    inbound && inbound.length > 0 && inbound.length <= MAX_INBOUND_ID_LENGTH
      ? inbound
      : randomUUID();

  req.id = id;
  req.log = logger.child({ requestId: id });
  res.setHeader('X-Request-Id', id);

  const startedAt = process.hrtime.bigint();
  req.log.info({ method: req.method, path: req.path }, 'Request started');

  // res.on('finish') fires exactly once the response has actually been
  // fully sent — including responses written later by the error handler
  // — so this is the one place completion gets logged, regardless of
  // whether the request succeeded or errored downstream.
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    // route (a pattern, e.g. "/api/links/:id") is what makes this line
    // safe to aggregate by later — see getRoutePattern above. path is
    // kept alongside it for human debugging of one specific request, not
    // for aggregation.
    req.log.info(
      {
        method: req.method,
        path: req.path,
        route: getRoutePattern(req),
        statusCode: res.statusCode,
        durationMs,
      },
      'Request completed',
    );
  });

  next();
}
