import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import swaggerUi from 'swagger-ui-express';

/**
 * Reads the committed openapi.json once, at import time — not
 * regenerated per-request, so /docs and /openapi.json always reflect
 * exactly the artifact that's in git, not a live spec that could
 * silently differ from what a consumer (e.g. clickscope-web) generated
 * a client against. Regenerate it explicitly with `npm run
 * openapi:generate` (scripts/generate-openapi.ts) after changing a
 * route or schema.
 *
 * process.cwd() rather than an import.meta.url-relative path: every
 * existing npm script (dev, start, worker:dev, etc.) already runs from
 * the repo root, and a relative path's depth would differ between a
 * tsx-run src/routes/docs.ts (dev) and compiled dist/routes/docs.js
 * (build output) — process.cwd() is the one thing both agree on.
 */
const openapiDocument: Record<string, unknown> = JSON.parse(
  readFileSync(path.join(process.cwd(), 'openapi.json'), 'utf-8'),
);

export const docsRouter = Router();

docsRouter.use('/docs', swaggerUi.serve, swaggerUi.setup(openapiDocument));
docsRouter.get('/openapi.json', (_req, res) => {
  res.json(openapiDocument);
});
