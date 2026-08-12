import { Router } from 'express';
import { serviceName, serviceVersion } from '../lib/serviceInfo.js';

export const rootRouter = Router();

/**
 * Liveness probe: answers "is this process running and able to respond
 * to HTTP at all," with zero dependency checks. This is what an
 * orchestrator's liveness check should hit — if it fails, the correct
 * response is to kill and restart the container, since the process
 * itself is presumed broken. Contrast with GET /health
 * (src/routes/health.ts), the readiness probe, which does check
 * dependencies: wiring dependency checks into liveness instead would
 * cause a restart-crash-loop on every transient downstream blip.
 */
rootRouter.get('/', (_req, res) => {
  res.json({ name: serviceName, version: serviceVersion });
});
