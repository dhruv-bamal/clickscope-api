import { Router } from 'express';
import { getHealthReport } from '../services/health.js';

export const healthRouter = Router();

/**
 * Readiness probe: answers "can this instance currently serve real
 * traffic," by checking Postgres and Redis connectivity. Returns 503 (not
 * 200-with-a-status-field) when a dependency is down, so a standard
 * orchestrator health check — which keys off HTTP status, not response
 * body — correctly stops routing traffic to this instance without any
 * body-parsing logic of its own. See Notes.md, "Phase 3: API Foundation"
 * for the liveness-vs-readiness distinction against GET / (src/routes/root.ts).
 */
healthRouter.get('/health', async (_req, res) => {
  const report = await getHealthReport();
  res.status(report.status === 'ok' ? 200 : 503).json(report);
});
