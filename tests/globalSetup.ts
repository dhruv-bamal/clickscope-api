import { Client } from 'pg';
import { runner } from 'node-pg-migrate';

/**
 * Runs once before the whole test suite. Points DATABASE_URL at a
 * dedicated `clickscope_test` database (never the developer's own dev
 * database in `.env`), provisions it if it doesn't exist yet, and applies
 * every migration — so `npm test` is fully self-contained for a new
 * contributor, with no manual "migrate the test DB first" step.
 */
export async function setup(): Promise<void> {
  process.loadEnvFile('.env.test');

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set — check .env.test exists and is loaded');
  }

  await ensureDatabaseExists(databaseUrl);

  await runner({
    databaseUrl,
    dir: 'migrations',
    migrationsTable: 'pgmigrations',
    direction: 'up',
  });
}

/**
 * `CREATE DATABASE` can't run inside a transaction and can't target the
 * database you're connected to, so this connects to the admin `postgres`
 * database first. The identifier is interpolated (not parameterized) only
 * because Postgres doesn't support parameterizing identifiers at all — safe
 * here because the name comes from our own DATABASE_URL config, never from
 * request input.
 */
async function ensureDatabaseExists(databaseUrl: string): Promise<void> {
  const target = new URL(databaseUrl);
  const dbName = target.pathname.replace(/^\//, '');

  const adminUrl = new URL(target);
  adminUrl.pathname = '/postgres';

  const client = new Client({ connectionString: adminUrl.toString() });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE "${dbName}"`);
  } catch (err) {
    const isDuplicateDatabase =
      typeof err === 'object' && err !== null && 'code' in err && err.code === '42P04';
    if (!isDuplicateDatabase) {
      throw err;
    }
  } finally {
    await client.end();
  }
}
