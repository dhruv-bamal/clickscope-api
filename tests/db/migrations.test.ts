import { describe, expect, it } from 'vitest';
import { runner } from 'node-pg-migrate';
import { Client } from 'pg';

// Redundant with tests/globalSetup.ts's own load, but test files may run in
// a separate worker/process from globalSetup — reloading here is a cheap,
// idempotent guard against DATABASE_URL not having propagated.
process.loadEnvFile('.env.test');

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is not set — check .env.test exists');
}

async function tableExists(client: Client, tableName: string): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1
     ) AS exists`,
    [tableName],
  );
  return result.rows[0]?.exists ?? false;
}

async function indexExists(client: Client, indexName: string): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_indexes
       WHERE schemaname = 'public' AND indexname = $1
     ) AS exists`,
    [indexName],
  );
  return result.rows[0]?.exists ?? false;
}

// Phase 11's indexes — asserted present so a future migration accidentally
// dropping one of these fails this test loudly, rather than silently
// degrading listLinks/sweepExpiredLinks/getLinkClickStats back to a scan.
const PHASE_11_INDEXES = [
  'links_user_id_created_at_id_index',
  'links_expires_at_active_partial_index',
  'clicks_link_id_clicked_at_index',
];

describe('migrations', () => {
  it('applies all migrations, creating the expected tables', async () => {
    // globalSetup already ran migrations up before any test file starts;
    // this just verifies the resulting shape.
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      for (const table of ['users', 'links', 'clicks', 'pgmigrations']) {
        expect(await tableExists(client, table)).toBe(true);
      }
    } finally {
      await client.end();
    }
  });

  it('creates the Phase 11 performance indexes', async () => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      for (const indexName of PHASE_11_INDEXES) {
        expect(await indexExists(client, indexName)).toBe(true);
      }
    } finally {
      await client.end();
    }
  });

  // This test runs real DDL outside a rolled-back transaction, by design —
  // it's the one place we need to prove migrations actually apply/revert
  // against real schema state, which a transaction wrapper would defeat.
  // It always re-applies "up" before returning, so the schema is intact
  // for other test files regardless of run order — but it must still run
  // to completion without another file querying the tables concurrently,
  // which is why vitest.config.ts disables fileParallelism.
  it('rolls back cleanly with down migrations, then re-applies up', async () => {
    await runner({
      databaseUrl,
      dir: 'migrations',
      migrationsTable: 'pgmigrations',
      direction: 'down',
      count: 5,
    });

    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      for (const table of ['users', 'links', 'clicks']) {
        expect(await tableExists(client, table)).toBe(false);
      }
    } finally {
      await client.end();
    }

    await runner({
      databaseUrl,
      dir: 'migrations',
      migrationsTable: 'pgmigrations',
      direction: 'up',
    });

    const clientAfterReup = new Client({ connectionString: databaseUrl });
    await clientAfterReup.connect();
    try {
      for (const indexName of PHASE_11_INDEXES) {
        expect(await indexExists(clientAfterReup, indexName)).toBe(true);
      }
    } finally {
      await clientAfterReup.end();
    }
  });
});
