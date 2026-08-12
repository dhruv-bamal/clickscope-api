import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Read name/version from package.json at runtime rather than hardcoding
// them, so they can never drift out of sync with the package that's
// actually deployed. Resolved relative to this file (not process.cwd()),
// so it works identically whether run via `tsx src/server.ts` in dev or
// `node dist/server.js` in production. Read exactly once, at import time,
// and shared by src/app.ts (startup log line) and src/routes/root.ts
// (liveness response body) so neither duplicates the file read.
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const { name, version } = JSON.parse(
  readFileSync(path.join(currentDir, '..', '..', 'package.json'), 'utf-8'),
) as { name: string; version: string };

export const serviceName = name;
export const serviceVersion = version;
