import type { Express } from 'express';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Config } from '../../src/config/env.js';

let app: Express;
let config: Config;
let query: typeof import('../../src/db/pool.js').query;
let rateLimitRedisConnection: typeof import('../../src/lib/rateLimitRedis.js').rateLimitRedisConnection;

beforeAll(async () => {
  // Same dynamic-import-after-loadEnvFile requirement as tests/routes/auth.test.ts —
  // src/app.ts transitively imports src/config at module-evaluation time.
  process.loadEnvFile('.env.test');
  ({ app } = await import('../../src/app.js'));
  ({ config } = await import('../../src/config/index.js'));
  ({ query } = await import('../../src/db/pool.js'));
  ({ rateLimitRedisConnection } = await import('../../src/lib/rateLimitRedis.js'));

  // See tests/routes/auth.test.ts's beforeAll for why this file-local flush
  // is necessary now that signupLimiter is backed by real, shared Redis
  // rather than a per-process in-memory Map: every test file's supertest
  // requests share one loopback IP, so without this flush this file's ~40
  // signupUser() calls could inherit budget already spent by whichever
  // file ran immediately before it in the same `npm test` run. (This
  // file's own rate limiting describe below tests linksCreateLimiter,
  // which is keyed per-user and needs no such flush — it never collides
  // across files.)
  const authLimiterKeys = await rateLimitRedisConnection.keys('rl:auth-*');
  if (authLimiterKeys.length > 0) {
    await rateLimitRedisConnection.del(...authLimiterKeys);
  }
});

function uniqueEmail(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

function uniqueAlias(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** password_hash must never appear in a response body, under any key spelling. */
function assertNoPasswordHash(body: unknown): void {
  const serialized = JSON.stringify(body);
  expect(serialized.toLowerCase()).not.toContain('password_hash');
  expect(serialized.toLowerCase()).not.toContain('passwordhash');
  expect(serialized).not.toContain('$2a$');
  expect(serialized).not.toContain('$2b$');
}

async function signupUser(label: string): Promise<{ token: string; userId: string }> {
  const res = await request(app)
    .post('/api/auth/signup')
    .send({ email: uniqueEmail(label), password: 'a-valid-password' });
  return { token: res.body.token as string, userId: res.body.user.id as string };
}

function post(token: string, body: Record<string, unknown>) {
  return request(app).post('/api/links').set('Authorization', `Bearer ${token}`).send(body);
}

describe('POST /api/links', () => {
  it('creates a link with a generated short code', async () => {
    const { token } = await signupUser('create-generated');

    const res = await post(token, { destinationUrl: 'https://example.com/generated' });

    expect(res.status).toBe(201);
    expect(res.body.link.destinationUrl).toBe('https://example.com/generated');
    expect(res.body.link.shortCode).toMatch(/^[0-9A-Za-z]{7}$/);
  });

  it('creates a link with a custom alias', async () => {
    const { token } = await signupUser('create-alias');
    const alias = uniqueAlias('myalias');

    const res = await post(token, {
      destinationUrl: 'https://example.com/alias',
      customAlias: alias,
    });

    expect(res.status).toBe(201);
    expect(res.body.link.shortCode).toBe(alias);
  });

  it('rejects a duplicate custom alias with 409, even across two different users', async () => {
    const { token: tokenA } = await signupUser('dup-alias-a');
    const { token: tokenB } = await signupUser('dup-alias-b');
    const alias = uniqueAlias('taken');

    await post(tokenA, { destinationUrl: 'https://example.com/first', customAlias: alias });
    const res = await post(tokenB, {
      destinationUrl: 'https://example.com/second',
      customAlias: alias,
    });

    expect(res.status).toBe(409);
  });

  it('rejects a reserved-word alias with 400', async () => {
    const { token } = await signupUser('reserved-alias');

    const res = await post(token, {
      destinationUrl: 'https://example.com/admin',
      customAlias: 'admin',
    });

    expect(res.status).toBe(400);
  });

  it('rejects a javascript: destination URL with 400', async () => {
    const { token } = await signupUser('js-scheme');

    const res = await post(token, { destinationUrl: 'javascript:alert(1)' });

    expect(res.status).toBe(400);
  });

  it('rejects a data: destination URL with 400', async () => {
    const { token } = await signupUser('data-scheme');

    const res = await post(token, { destinationUrl: 'data:text/html,<script>alert(1)</script>' });

    expect(res.status).toBe(400);
  });

  it('rejects an expiresAt in the past with 400', async () => {
    const { token } = await signupUser('past-expiry');

    const res = await post(token, {
      destinationUrl: 'https://example.com/expired',
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    expect(res.status).toBe(400);
  });

  it('rejects a non-positive maxClicks with 400', async () => {
    const { token } = await signupUser('bad-maxclicks');

    const res = await post(token, {
      destinationUrl: 'https://example.com/maxclicks',
      maxClicks: 0,
    });

    expect(res.status).toBe(400);
  });

  it('rejects an unauthenticated request with 401', async () => {
    const res = await request(app)
      .post('/api/links')
      .send({ destinationUrl: 'https://example.com' });
    expect(res.status).toBe(401);
  });

  it('creates a password-protected link: isPasswordProtected true, no password_hash leaked', async () => {
    const { token } = await signupUser('create-password');

    const res = await post(token, {
      destinationUrl: 'https://example.com/gated',
      password: 'link-secret',
    });

    expect(res.status).toBe(201);
    expect(res.body.link.isPasswordProtected).toBe(true);
    assertNoPasswordHash(res.body);
  });

  it('creates a link with no password: isPasswordProtected is false', async () => {
    const { token } = await signupUser('create-open');

    const res = await post(token, { destinationUrl: 'https://example.com/open' });

    expect(res.status).toBe(201);
    expect(res.body.link.isPasswordProtected).toBe(false);
    assertNoPasswordHash(res.body);
  });
});

describe('rate limiting', () => {
  it("is keyed per authenticated user, not per IP: exhausting user A's budget does not block user B", async () => {
    const { token: tokenA } = await signupUser('rl-links-a');
    const { token: tokenB } = await signupUser('rl-links-b');

    let last: request.Response | undefined;
    for (let i = 0; i < config.RATE_LIMIT_LINKS_MAX + 1; i += 1) {
      last = await post(tokenA, { destinationUrl: `https://example.com/rl-a-${i}` });
    }
    expect(last!.status).toBe(429);
    expect(last!.body.error.code).toBe('TOO_MANY_REQUESTS');
    expect(Number(last!.headers['retry-after'])).toBeGreaterThan(0);

    const resB = await post(tokenB, { destinationUrl: 'https://example.com/rl-b' });
    expect(resB.status).toBe(201);
  });
});

describe('GET /api/links', () => {
  it('returns links with the default page size when no query params are given', async () => {
    const { token } = await signupUser('list-default');
    await post(token, { destinationUrl: 'https://example.com/one' });

    const res = await request(app).get('/api/links').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.pagination.limit).toBe(20);
    expect(res.body.pagination.offset).toBe(0);
  });

  it('clamps a limit above the maximum instead of rejecting it', async () => {
    const { token } = await signupUser('list-clamp');
    await post(token, { destinationUrl: 'https://example.com/clamp' });

    const res = await request(app)
      .get('/api/links')
      .query({ limit: 1000 })
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.pagination.limit).toBe(100);
  });

  it('paginates to a correct next page', async () => {
    const { token } = await signupUser('list-nextpage');
    for (let i = 0; i < 3; i += 1) {
      await post(token, { destinationUrl: `https://example.com/page-${i}` });
    }

    const firstPage = await request(app)
      .get('/api/links')
      .query({ limit: 2, offset: 0 })
      .set('Authorization', `Bearer ${token}`);
    const secondPage = await request(app)
      .get('/api/links')
      .query({ limit: 2, offset: 2 })
      .set('Authorization', `Bearer ${token}`);

    expect(firstPage.body.links).toHaveLength(2);
    expect(secondPage.body.links).toHaveLength(1);
    expect(firstPage.body.pagination.total).toBe(3);
    expect(firstPage.body.pagination.hasMore).toBe(true);
    expect(secondPage.body.pagination.hasMore).toBe(false);

    const firstIds = new Set(firstPage.body.links.map((link: { id: string }) => link.id));
    const overlap = secondPage.body.links.filter((link: { id: string }) => firstIds.has(link.id));
    expect(overlap).toHaveLength(0);
  });

  it("never includes another user's links", async () => {
    const { token: tokenA } = await signupUser('list-isolation-a');
    const { token: tokenB } = await signupUser('list-isolation-b');
    await post(tokenA, { destinationUrl: 'https://example.com/a' });
    await post(tokenB, { destinationUrl: 'https://example.com/b1' });
    await post(tokenB, { destinationUrl: 'https://example.com/b2' });

    const res = await request(app).get('/api/links').set('Authorization', `Bearer ${tokenA}`);

    expect(res.body.links).toHaveLength(1);
    expect(res.body.links[0].destinationUrl).toBe('https://example.com/a');
  });

  it('never leaks password_hash for a password-protected link', async () => {
    const { token } = await signupUser('list-no-leak');
    await post(token, { destinationUrl: 'https://example.com/gated', password: 'link-secret' });

    const res = await request(app).get('/api/links').set('Authorization', `Bearer ${token}`);

    assertNoPasswordHash(res.body);
  });
});

describe('GET /api/links/:id', () => {
  it('returns the link for its owner', async () => {
    const { token } = await signupUser('getid-owner');
    const created = await post(token, { destinationUrl: 'https://example.com/mine' });

    const res = await request(app)
      .get(`/api/links/${created.body.link.id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.link.id).toBe(created.body.link.id);
  });

  it('returns 400, not 500, for a malformed UUID', async () => {
    const { token } = await signupUser('getid-malformed');

    const res = await request(app)
      .get('/api/links/not-a-uuid')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
  });

  it('never leaks password_hash for a password-protected link', async () => {
    const { token } = await signupUser('getid-no-leak');
    const created = await post(token, {
      destinationUrl: 'https://example.com/gated',
      password: 'link-secret',
    });

    const res = await request(app)
      .get(`/api/links/${created.body.link.id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.body.link.isPasswordProtected).toBe(true);
    assertNoPasswordHash(res.body);
  });
});

describe('GET /api/links/:id/stats', () => {
  async function insertClick(linkId: string, clickedAt: Date): Promise<void> {
    await query('INSERT INTO clicks (link_id, clicked_at) VALUES ($1, $2)', [linkId, clickedAt]);
  }

  it('returns an empty array, not 404, for a link with no clicks', async () => {
    const { token } = await signupUser('stats-empty');
    const created = await post(token, { destinationUrl: 'https://example.com/no-clicks' });

    const res = await request(app)
      .get(`/api/links/${created.body.link.id}/stats`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.stats).toEqual([]);
  });

  it('groups clicks by day, correctly ordered', async () => {
    const { token } = await signupUser('stats-grouped');
    const created = await post(token, { destinationUrl: 'https://example.com/grouped' });
    const linkId = created.body.link.id as string;

    const dayOne = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const dayTwo = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
    await insertClick(linkId, dayOne);
    await insertClick(linkId, dayOne);
    await insertClick(linkId, dayTwo);

    const res = await request(app)
      .get(`/api/links/${linkId}/stats`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.stats).toHaveLength(2);
    expect(res.body.stats[0].clicks).toBe(2);
    expect(res.body.stats[1].clicks).toBe(1);
    expect(res.body.stats[0].day < res.body.stats[1].day).toBe(true);
  });

  it('excludes clicks older than the days window', async () => {
    const { token } = await signupUser('stats-window');
    const created = await post(token, { destinationUrl: 'https://example.com/windowed' });
    const linkId = created.body.link.id as string;

    await insertClick(linkId, new Date(Date.now() - 40 * 24 * 60 * 60 * 1000));
    await insertClick(linkId, new Date(Date.now() - 1 * 24 * 60 * 60 * 1000));

    const res = await request(app)
      .get(`/api/links/${linkId}/stats`)
      .query({ days: 30 })
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.stats).toHaveLength(1);
    expect(res.body.days).toBe(30);
  });

  it('clamps a days value above the maximum instead of rejecting it', async () => {
    const { token } = await signupUser('stats-clamp');
    const created = await post(token, { destinationUrl: 'https://example.com/clamp-days' });

    const res = await request(app)
      .get(`/api/links/${created.body.link.id}/stats`)
      .query({ days: 10_000 })
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.days).toBe(365);
  });

  it("returns 404 for another user's link, not another user's data", async () => {
    const { token: tokenA } = await signupUser('stats-authz-a');
    const { token: tokenB } = await signupUser('stats-authz-b');
    const created = await post(tokenA, { destinationUrl: 'https://example.com/not-yours' });
    await insertClick(created.body.link.id, new Date());

    const res = await request(app)
      .get(`/api/links/${created.body.link.id}/stats`)
      .set('Authorization', `Bearer ${tokenB}`);

    expect(res.status).toBe(404);
  });

  it('returns 404 for a link id that does not exist at all', async () => {
    const { token } = await signupUser('stats-nonexistent');

    const res = await request(app)
      .get('/api/links/00000000-0000-0000-0000-000000000000/stats')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
  });

  it('returns 400, not 500, for a malformed UUID', async () => {
    const { token } = await signupUser('stats-malformed');

    const res = await request(app)
      .get('/api/links/not-a-uuid/stats')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
  });
});

describe("object-level authorization: user B against user A's link", () => {
  it('GET returns 404 and leaves the row unchanged', async () => {
    const { token: tokenA } = await signupUser('authz-get-a');
    const { token: tokenB } = await signupUser('authz-get-b');
    const created = await post(tokenA, { destinationUrl: 'https://example.com/protected' });
    const linkId = created.body.link.id as string;

    const res = await request(app)
      .get(`/api/links/${linkId}`)
      .set('Authorization', `Bearer ${tokenB}`);
    expect(res.status).toBe(404);

    const stored = await query<{ destination_url: string }>(
      'SELECT destination_url FROM links WHERE id = $1',
      [linkId],
    );
    expect(stored.rows[0]?.destination_url).toBe('https://example.com/protected');
  });

  it('PATCH returns 404 and leaves the row unchanged', async () => {
    const { token: tokenA } = await signupUser('authz-patch-a');
    const { token: tokenB } = await signupUser('authz-patch-b');
    const created = await post(tokenA, { destinationUrl: 'https://example.com/protected' });
    const linkId = created.body.link.id as string;

    const res = await request(app)
      .patch(`/api/links/${linkId}`)
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ destinationUrl: 'https://example.com/hijacked' });
    expect(res.status).toBe(404);

    const stored = await query<{ destination_url: string }>(
      'SELECT destination_url FROM links WHERE id = $1',
      [linkId],
    );
    expect(stored.rows[0]?.destination_url).toBe('https://example.com/protected');
  });

  it('DELETE returns 404 and the row still exists', async () => {
    const { token: tokenA } = await signupUser('authz-delete-a');
    const { token: tokenB } = await signupUser('authz-delete-b');
    const created = await post(tokenA, { destinationUrl: 'https://example.com/protected' });
    const linkId = created.body.link.id as string;

    const res = await request(app)
      .delete(`/api/links/${linkId}`)
      .set('Authorization', `Bearer ${tokenB}`);
    expect(res.status).toBe(404);

    const stored = await query('SELECT id FROM links WHERE id = $1', [linkId]);
    expect(stored.rows).toHaveLength(1);
  });
});

describe('PATCH /api/links/:id', () => {
  it('a partial update leaves other fields untouched', async () => {
    const { token } = await signupUser('patch-partial');
    const created = await post(token, {
      destinationUrl: 'https://example.com/original',
      maxClicks: 10,
    });

    const res = await request(app)
      .patch(`/api/links/${created.body.link.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ destinationUrl: 'https://example.com/changed' });

    expect(res.status).toBe(200);
    expect(res.body.link.destinationUrl).toBe('https://example.com/changed');
    expect(res.body.link.maxClicks).toBe(10);
  });

  it('an explicit null clears a nullable field', async () => {
    const { token } = await signupUser('patch-clear');
    const created = await post(token, {
      destinationUrl: 'https://example.com/original',
      maxClicks: 10,
    });

    const res = await request(app)
      .patch(`/api/links/${created.body.link.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ maxClicks: null });

    expect(res.status).toBe(200);
    expect(res.body.link.maxClicks).toBeNull();
  });

  it('an empty body is a no-op that leaves the link unchanged', async () => {
    const { token } = await signupUser('patch-empty');
    const created = await post(token, { destinationUrl: 'https://example.com/noop' });

    const res = await request(app)
      .patch(`/api/links/${created.body.link.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.link.destinationUrl).toBe('https://example.com/noop');
  });

  it('rejects an attempt to change the short code with 400', async () => {
    const { token } = await signupUser('patch-alias-immutable');
    const created = await post(token, { destinationUrl: 'https://example.com/immutable' });

    const res = await request(app)
      .patch(`/api/links/${created.body.link.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ customAlias: 'new-alias' });

    expect(res.status).toBe(400);
  });

  it('returns 400, not 500, for a malformed UUID', async () => {
    const { token } = await signupUser('patch-malformed');

    const res = await request(app)
      .patch('/api/links/not-a-uuid')
      .set('Authorization', `Bearer ${token}`)
      .send({ destinationUrl: 'https://example.com/x' });

    expect(res.status).toBe(400);
  });

  it('sets a password on a previously open link, no password_hash leaked', async () => {
    const { token } = await signupUser('patch-set-password');
    const created = await post(token, { destinationUrl: 'https://example.com/open' });

    const res = await request(app)
      .patch(`/api/links/${created.body.link.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ password: 'new-link-password' });

    expect(res.status).toBe(200);
    expect(res.body.link.isPasswordProtected).toBe(true);
    assertNoPasswordHash(res.body);
  });

  it('an explicit null clears a password', async () => {
    const { token } = await signupUser('patch-clear-password');
    const created = await post(token, {
      destinationUrl: 'https://example.com/gated',
      password: 'original-password',
    });

    const res = await request(app)
      .patch(`/api/links/${created.body.link.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ password: null });

    expect(res.status).toBe(200);
    expect(res.body.link.isPasswordProtected).toBe(false);
  });

  it('leaves the password unchanged when the key is absent from the body', async () => {
    const { token } = await signupUser('patch-password-unchanged');
    const created = await post(token, {
      destinationUrl: 'https://example.com/gated',
      password: 'stays-the-same',
    });

    const res = await request(app)
      .patch(`/api/links/${created.body.link.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ destinationUrl: 'https://example.com/moved' });

    expect(res.status).toBe(200);
    expect(res.body.link.isPasswordProtected).toBe(true);
  });
});

describe('DELETE /api/links/:id', () => {
  it('deletes the link and returns 204', async () => {
    const { token } = await signupUser('delete-owner');
    const created = await post(token, { destinationUrl: 'https://example.com/todelete' });

    const res = await request(app)
      .delete(`/api/links/${created.body.link.id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(204);

    const stored = await query('SELECT id FROM links WHERE id = $1', [created.body.link.id]);
    expect(stored.rows).toHaveLength(0);
  });

  it('returns 400, not 500, for a malformed UUID', async () => {
    const { token } = await signupUser('delete-malformed');

    const res = await request(app)
      .delete('/api/links/not-a-uuid')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
  });
});
