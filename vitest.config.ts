import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/globalSetup.ts'],
    // All current tests are integration tests against one real Postgres
    // database (tests/db/*.test.ts) — migrations.test.ts drops and
    // re-creates tables that constraints.test.ts depends on, so test files
    // must run one at a time, in a predictable order, not in parallel.
    fileParallelism: false,
    // v8, not istanbul: vitest 3's native provider needs no separate
    // source-instrumentation pass, so it doesn't perturb the stack traces
    // this suite's own tests (asyncErrors.test.ts, errorHandler.test.ts)
    // assert against. Precision is more than sufficient for a number
    // Phase 13a treats as a map of what's untested, not a target to hit —
    // istanbul's finer branch remapping isn't worth its slower
    // instrumented runs for that purpose. Run with `npm run test:coverage`.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
    },
  },
});
