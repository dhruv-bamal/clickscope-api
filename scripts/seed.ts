import { pool, query } from '../src/db/pool.js';
import { logger } from '../src/lib/logger.js';

interface SeedLink {
  shortCode: string;
  destinationUrl: string;
}

interface SeedUser {
  email: string;
  passwordHash: string | null;
  oauthProvider: string | null;
  oauthId: string | null;
  links: SeedLink[];
}

/**
 * Small, obviously-fake development data. Fixed and deterministic (not
 * randomly generated) so the idempotency checks below can reliably detect
 * "this already exists" on a re-run.
 */
const SEED_USERS: SeedUser[] = [
  {
    email: 'dev@example.com',
    passwordHash: 'fake-hash-not-a-real-bcrypt-value',
    oauthProvider: null,
    oauthId: null,
    links: [
      { shortCode: 'demo1', destinationUrl: 'https://example.com/articles/one' },
      { shortCode: 'demo2', destinationUrl: 'https://example.com/articles/two' },
    ],
  },
  {
    email: 'oauth-dev@example.com',
    passwordHash: null,
    oauthProvider: 'google',
    oauthId: 'fake-google-id-123',
    links: [{ shortCode: 'demo3', destinationUrl: 'https://example.com/articles/three' }],
  },
];

const CLICKS_PER_LINK = 3;

/**
 * Users can't use `ON CONFLICT (email)` for idempotency because the actual
 * uniqueness constraint lives on the functional `lower(email)` index, not
 * the bare column — an existence check is the correct conflict target
 * here, not a redundant second constraint.
 */
async function upsertUser(user: SeedUser): Promise<{ id: string; inserted: boolean }> {
  const existing = await query<{ id: string }>(
    'SELECT id FROM users WHERE lower(email) = lower($1)',
    [user.email],
  );
  const existingRow = existing.rows[0];
  if (existingRow) {
    return { id: existingRow.id, inserted: false };
  }

  const result = await query<{ id: string }>(
    `INSERT INTO users (email, password_hash, oauth_provider, oauth_id)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [user.email, user.passwordHash, user.oauthProvider, user.oauthId],
  );
  const inserted = result.rows[0];
  if (!inserted) {
    throw new Error(`Failed to insert seed user ${user.email}`);
  }
  return { id: inserted.id, inserted: true };
}

/** short_code is a plain unique column, so ON CONFLICT DO NOTHING works directly. */
async function upsertLink(
  userId: string,
  link: SeedLink,
): Promise<{ id: string; inserted: boolean }> {
  const result = await query<{ id: string }>(
    `INSERT INTO links (user_id, short_code, destination_url)
     VALUES ($1, $2, $3)
     ON CONFLICT (short_code) DO NOTHING
     RETURNING id`,
    [userId, link.shortCode, link.destinationUrl],
  );
  const inserted = result.rows[0];
  if (inserted) {
    return { id: inserted.id, inserted: true };
  }

  const existing = await query<{ id: string }>('SELECT id FROM links WHERE short_code = $1', [
    link.shortCode,
  ]);
  const existingRow = existing.rows[0];
  if (!existingRow) {
    throw new Error(`Failed to find or insert seed link ${link.shortCode}`);
  }
  return { id: existingRow.id, inserted: false };
}

/**
 * clicks has no natural unique key by design (multiple clicks per link is
 * the normal case), so idempotency here means topping a link up to a fixed
 * target count rather than relying on a conflict target.
 */
async function ensureClicks(linkId: string, targetCount: number): Promise<number> {
  const existing = await query<{ count: string }>(
    'SELECT COUNT(*)::int AS count FROM clicks WHERE link_id = $1',
    [linkId],
  );
  const existingCount = Number(existing.rows[0]?.count ?? 0);
  const missing = targetCount - existingCount;
  if (missing <= 0) {
    return 0;
  }

  for (let i = 0; i < missing; i += 1) {
    await query(
      `INSERT INTO clicks (link_id, referrer, user_agent, country)
       VALUES ($1, $2, $3, $4)`,
      [linkId, 'https://seed-referrer.example.com', 'seed-script/1.0', 'US'],
    );
  }
  return missing;
}

async function main(): Promise<void> {
  let usersInserted = 0;
  let linksInserted = 0;
  let clicksInserted = 0;

  for (const seedUser of SEED_USERS) {
    const { id: userId, inserted: userInserted } = await upsertUser(seedUser);
    if (userInserted) usersInserted += 1;

    for (const seedLink of seedUser.links) {
      const { id: linkId, inserted: linkInserted } = await upsertLink(userId, seedLink);
      if (linkInserted) linksInserted += 1;

      clicksInserted += await ensureClicks(linkId, CLICKS_PER_LINK);
    }
  }

  logger.info({ usersInserted, linksInserted, clicksInserted }, 'Seed complete');
}

main()
  .catch((err: unknown) => {
    logger.error({ err }, 'Seed script failed');
    process.exitCode = 1;
  })
  .finally(() => {
    void pool.end();
  });
