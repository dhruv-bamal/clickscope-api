import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';

process.loadEnvFile('.env.test');

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is not set — check .env.test exists');
}

// A single connection, with every test wrapped in BEGIN/ROLLBACK, so rows
// never leak between tests without needing full table truncation. This is
// the row-level counterpart to migrations.test.ts's real-DDL test — DDL
// there has to run outside a transaction, but everything here is plain DML
// and belongs inside one.
let client: Client;

beforeAll(async () => {
  client = new Client({ connectionString: databaseUrl });
  await client.connect();
});

afterAll(async () => {
  await client.end();
});

beforeEach(async () => {
  await client.query('BEGIN');
});

afterEach(async () => {
  await client.query('ROLLBACK');
});

describe('users password/oauth CHECK constraint', () => {
  it('rejects a user with both a password and an OAuth identity', async () => {
    await expect(
      client.query(
        `INSERT INTO users (email, password_hash, oauth_provider, oauth_id)
         VALUES ($1, $2, $3, $4)`,
        ['both@example.com', 'hash', 'google', 'gid-1'],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects a user with neither a password nor an OAuth identity', async () => {
    await expect(
      client.query('INSERT INTO users (email) VALUES ($1)', ['neither@example.com']),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('accepts a password-only user', async () => {
    await expect(
      client.query('INSERT INTO users (email, password_hash) VALUES ($1, $2)', [
        'password-only@example.com',
        'hash',
      ]),
    ).resolves.toBeDefined();
  });

  it('accepts an oauth-only user', async () => {
    await expect(
      client.query('INSERT INTO users (email, oauth_provider, oauth_id) VALUES ($1, $2, $3)', [
        'oauth-only@example.com',
        'google',
        'gid-2',
      ]),
    ).resolves.toBeDefined();
  });
});

describe('users email case-insensitive uniqueness', () => {
  it('rejects a duplicate email that differs only in case', async () => {
    await client.query('INSERT INTO users (email, password_hash) VALUES ($1, $2)', [
      'Case@Example.com',
      'hash',
    ]);

    await expect(
      client.query('INSERT INTO users (email, password_hash) VALUES ($1, $2)', [
        'case@example.com',
        'hash',
      ]),
    ).rejects.toMatchObject({ code: '23505' });
  });
});

describe('links CHECK constraints', () => {
  it('rejects a non-positive max_clicks', async () => {
    const user = await client.query<{ id: string }>(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
      ['link-owner-1@example.com', 'hash'],
    );
    const userId = user.rows[0]?.id;

    await expect(
      client.query(
        `INSERT INTO links (user_id, short_code, destination_url, max_clicks)
         VALUES ($1, $2, $3, $4)`,
        [userId, 'bad-max', 'https://example.com', -1],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects a negative click_count', async () => {
    const user = await client.query<{ id: string }>(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
      ['link-owner-2@example.com', 'hash'],
    );
    const userId = user.rows[0]?.id;

    await expect(
      client.query(
        `INSERT INTO links (user_id, short_code, destination_url, click_count)
         VALUES ($1, $2, $3, $4)`,
        [userId, 'bad-count', 'https://example.com', -1],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('ON DELETE CASCADE', () => {
  it('deletes links and clicks when the owning user is deleted', async () => {
    const user = await client.query<{ id: string }>(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
      ['cascade-owner@example.com', 'hash'],
    );
    const userId = user.rows[0]?.id;

    const link = await client.query<{ id: string }>(
      'INSERT INTO links (user_id, short_code, destination_url) VALUES ($1, $2, $3) RETURNING id',
      [userId, 'cascade-link', 'https://example.com'],
    );
    const linkId = link.rows[0]?.id;

    await client.query('INSERT INTO clicks (link_id) VALUES ($1)', [linkId]);

    await client.query('DELETE FROM users WHERE id = $1', [userId]);

    const remainingLinks = await client.query('SELECT id FROM links WHERE id = $1', [linkId]);
    expect(remainingLinks.rows).toHaveLength(0);

    const remainingClicks = await client.query('SELECT id FROM clicks WHERE link_id = $1', [
      linkId,
    ]);
    expect(remainingClicks.rows).toHaveLength(0);
  });
});
