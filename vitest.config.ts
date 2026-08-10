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
  },
});
