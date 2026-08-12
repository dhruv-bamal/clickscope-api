import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { logger } from '../lib/logger.js';

const MAX_INBOUND_ID_LENGTH = 200;

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
    req.log.info(
      { method: req.method, path: req.path, statusCode: res.statusCode, durationMs },
      'Request completed',
    );
  });

  next();
}
