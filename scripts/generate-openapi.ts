import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { generateOpenApiDocument } from '../src/openapi/registry.js';

/**
 * Regenerates the committed openapi.json from the current Zod schemas.
 * Run explicitly (`npm run openapi:generate`) after changing a route or
 * schema — not on every boot, so the served spec (src/routes/docs.ts)
 * and the git-committed artifact are always the same reviewable thing.
 * tests/openapi/spec.test.ts fails if this drifts from a freshly
 * generated document, as a reminder to re-run it.
 */
function main(): void {
  const document = generateOpenApiDocument();
  const outputPath = path.join(process.cwd(), 'openapi.json');
  writeFileSync(outputPath, `${JSON.stringify(document, null, 2)}\n`, 'utf-8');
  console.log(`Wrote ${outputPath}`);
}

main();

// Importing the route files (for their exported Zod schemas) pulls in
// their module-level side effects too — the Postgres pool, the shared
// Redis client, and the BullMQ queue connection all open real sockets as
// soon as they're imported, none of which this script actually needs.
// Without an explicit exit, those open handles keep the event loop alive
// indefinitely even though main() has already finished. This script
// never touches a database or queue, so there's nothing to drain —
// process.exit(0) is the correct call here, not a workaround.
process.exit(0);
