import type { Express } from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ClickJobData } from '../../src/queues/contracts.js';

let app: Express;
let query: typeof import('../../src/db/pool.js').query;
let redis: typeof import('../../src/lib/redis.js').redis;
let clickQueue: typeof import('../../src/queues/clickQueue.js').clickQueue;
let processClickJob: typeof import('../../worker/processors/clickProcessor.js').processClickJob;
let sweepExpiredLinks: typeof import('../../worker/processors/linkCleanupProcessor.js').sweepExpiredLinks;

beforeAll(async () => {
  // Same dynamic-import-after-loadEnvFile requirement as tests/routes/links.test.ts —
  // src/app.ts transitively imports src/config at module-evaluation time.
  // worker/config.ts has the same requirement for its own (narrower) schema.
  process.loadEnvFile('.env.test');
  ({ app } = await import('../../src/app.js'));
  ({ query } = await import('../../src/db/pool.js'));
  ({ redis } = await import('../../src/lib/redis.js'));
  ({ clickQueue } = await import('../../src/queues/clickQueue.js'));
  ({ processClickJob } = await import('../../worker/processors/clickProcessor.js'));
  ({ sweepExpiredLinks } = await import('../../worker/processors/linkCleanupProcessor.js'));
});

afterAll(async () => {
  // Every GET /:shortCode in this file enqueues a real job — nothing in
  // this process consumes clickQueue (no worker runs during `npm test`),
  // so without this the jobs would just accumulate in the shared dev
  // Redis across every test run.
  await clickQueue.obliterate({ force: true });
});

function uniqueEmail(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

async function signupUser(label: string): Promise<{ token: string }> {
  const res = await request(app)
    .post('/api/auth/signup')
    .send({ email: uniqueEmail(label), password: 'a-valid-password' });
  return { token: res.body.token as string };
}

async function createLink(
  token: string,
  body: Record<string, unknown>,
): Promise<{ id: string; shortCode: string; destinationUrl: string }> {
  const res = await request(app)
    .post('/api/links')
    .set('Authorization', `Bearer ${token}`)
    .send(body);
  return res.body.link as { id: string; shortCode: string; destinationUrl: string };
}

/** Pulls one cookie's raw value out of a supertest response's Set-Cookie header(s). */
function extractCookieValue(setCookie: string[] | undefined, name: string): string {
  const line = (setCookie ?? []).find((c) => c.startsWith(`${name}=`));
  if (!line)
    throw new Error(
      `Cookie "${name}" not found in Set-Cookie header(s): ${JSON.stringify(setCookie)}`,
    );
  return line.slice(`${name}=`.length).split(';')[0]!;
}

/**
 * Hits GET /:shortCode and, if it enqueued a click, processes that job
 * immediately by calling processClickJob directly — standing in for the
 * real worker/ process, which nothing in this test run is consuming jobs
 * on behalf of. This is what lets tests that depend on click_count having
 * actually been written (e.g. maxClicks enforcement) stay fast and
 * deterministic instead of polling or sleeping for a real worker.
 */
async function getAndProcessClick(shortCode: string): Promise<request.Response> {
  const addSpy = vi.spyOn(clickQueue, 'add');
  const res = await request(app).get(`/${shortCode}`);
  const lastCall = addSpy.mock.calls.at(-1);
  addSpy.mockRestore();
  if (lastCall) {
    const [, data] = lastCall as [string, ClickJobData];
    await processClickJob(data);
  }
  return res;
}

describe('GET /:shortCode — valid link', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('redirects with 302 and the correct Location header', async () => {
    const { token } = await signupUser('redirect-valid');
    const link = await createLink(token, { destinationUrl: 'https://example.com/destination' });

    const res = await request(app).get(`/${link.shortCode}`);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://example.com/destination');
  });

  it('enqueues a click job with the correct payload instead of writing synchronously', async () => {
    const { token } = await signupUser('redirect-enqueues-click');
    const link = await createLink(token, { destinationUrl: 'https://example.com/tracked' });
    const addSpy = vi.spyOn(clickQueue, 'add');

    await request(app)
      .get(`/${link.shortCode}`)
      .set('Referer', 'https://referrer.example.com/page')
      .set('User-Agent', 'redirect-test-agent/1.0');

    expect(addSpy).toHaveBeenCalledTimes(1);
    const [name, data, opts] = addSpy.mock.calls[0] as [string, ClickJobData, { jobId: string }];
    expect(name).toBe('record-click');
    expect(data.linkId).toBe(link.id);
    expect(data.shortCode).toBe(link.shortCode);
    expect(data.referrer).toBe('https://referrer.example.com/page');
    expect(data.userAgent).toBe('redirect-test-agent/1.0');
    // clickId doubles as the BullMQ jobId — see Notes.md, "Phase 9:
    // Background Jobs" / "Idempotency."
    expect(opts.jobId).toBe(data.clickId);
    expect(data.clickId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('handles a missing referrer/user-agent gracefully (enqueued as null, not an error)', async () => {
    const { token } = await signupUser('redirect-no-headers');
    const link = await createLink(token, { destinationUrl: 'https://example.com/no-headers' });
    const addSpy = vi.spyOn(clickQueue, 'add');

    const res = await request(app).get(`/${link.shortCode}`).unset('User-Agent');

    expect(res.status).toBe(302);
    const [, data] = addSpy.mock.calls[0] as [string, ClickJobData];
    expect(data.referrer).toBeNull();
  });

  it('20 concurrent redirects to the same link enqueue 20 jobs with 20 distinct clickIds', async () => {
    // This is a different failure mode than processing-correctness (see
    // tests/worker/clickProcessor.test.ts, which proves 20 concurrently
    // *processed* jobs never lose an increment). The whole idempotency
    // design — both BullMQ's jobId dedup and the clicks.job_id unique
    // constraint — keys on clickId uniqueness holding in the first place.
    // If a producer bug ever caused two concurrent redirects to generate
    // the same clickId, both dedup layers would work exactly as designed
    // and silently drop a real click, and every test that only exercises
    // dedup given already-distinct keys would still pass. This test exists
    // specifically to catch that the uniqueness assumption itself holds.
    const { token } = await signupUser('redirect-distinct-clickids');
    const link = await createLink(token, {
      destinationUrl: 'https://example.com/distinct-clickids',
    });
    const CONCURRENCY = 20;
    const addSpy = vi.spyOn(clickQueue, 'add');

    await Promise.all(
      Array.from({ length: CONCURRENCY }, () => request(app).get(`/${link.shortCode}`)),
    );

    expect(addSpy).toHaveBeenCalledTimes(CONCURRENCY);
    const clickIds = addSpy.mock.calls.map(([, data]) => (data as ClickJobData).clickId);
    expect(new Set(clickIds).size).toBe(CONCURRENCY);
    for (const [, data] of addSpy.mock.calls) {
      expect((data as ClickJobData).linkId).toBe(link.id);
    }
  });

  it('an enqueue failure (e.g. Redis down) does not fail the redirect', async () => {
    // Mirrors the existing Redis-down pattern used for the link-lookup
    // cache below — the redirect's job is getting this visitor to
    // destinationUrl; a lost click is a bounded, self-contained failure,
    // whereas failing the redirect over a Redis blip would turn that blip
    // into a link-shortener-wide outage. See Notes.md, "Phase 9:
    // Background Jobs" for the full "accelerant" framing.
    const { token } = await signupUser('redirect-enqueue-failure');
    const link = await createLink(token, { destinationUrl: 'https://example.com/enqueue-down' });

    vi.spyOn(clickQueue, 'add').mockRejectedValueOnce(new Error('simulated Redis outage'));

    const res = await request(app).get(`/${link.shortCode}`);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://example.com/enqueue-down');
  });
});

describe('GET /:shortCode — dead/missing states', () => {
  it('returns 404 for a nonexistent short code', async () => {
    const res = await request(app).get('/does-not-exist-at-all');
    expect(res.status).toBe(404);
  });

  it('returns 410 for a deactivated link', async () => {
    const { token } = await signupUser('redirect-inactive');
    const link = await createLink(token, { destinationUrl: 'https://example.com/inactive' });
    await request(app)
      .patch(`/api/links/${link.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ isActive: false });

    const res = await request(app).get(`/${link.shortCode}`);

    expect(res.status).toBe(410);
  });

  it('returns 410 for a link expired by date', async () => {
    const { token } = await signupUser('redirect-expired-date');
    const link = await createLink(token, {
      destinationUrl: 'https://example.com/expired',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    // createLinkSchema rejects a past expiresAt at write time, so the past
    // date is set directly against the DB — the same "bypass the API to
    // set up state the API itself wouldn't allow" pattern used in
    // tests/services/linkService.test.ts's collision-retry tests.
    await query("UPDATE links SET expires_at = now() - interval '1 hour' WHERE id = $1", [link.id]);

    const res = await request(app).get(`/${link.shortCode}`);

    expect(res.status).toBe(410);
  });

  it('returns 410 once click_count reaches maxClicks', async () => {
    const { token } = await signupUser('redirect-maxclicks');
    const link = await createLink(token, {
      destinationUrl: 'https://example.com/limited',
      maxClicks: 1,
    });

    // Click processing now happens in a separate worker process — driven
    // directly here (via getAndProcessClick) rather than waited on, since
    // nothing in this test run is consuming clickQueue.
    const first = await getAndProcessClick(link.shortCode);
    expect(first.status).toBe(302);

    // A capped link is cached with a short TTL (see "response caching
    // (Redis)" below) precisely because click_count can be stale — an
    // immediate next request can still land within that accepted
    // overshoot window and get served again. Waiting past the capped TTL
    // is what actually proves the limit takes effect, rather than
    // asserting an immediate-enforcement guarantee caching no longer makes.
    await new Promise((resolve) => setTimeout(resolve, 6000));

    const second = await request(app).get(`/${link.shortCode}`);
    expect(second.status).toBe(410);
  }, 15000);
});

describe('password-protected links', () => {
  it('GET without a cookie serves the interstitial, not a redirect', async () => {
    const { token } = await signupUser('redirect-password-interstitial');
    const link = await createLink(token, {
      destinationUrl: 'https://example.com/gated',
      password: 'correct-horse',
    });

    const res = await request(app).get(`/${link.shortCode}`);

    expect(res.status).toBe(200);
    expect(res.headers.location).toBeUndefined();
    expect(res.text).toContain('<form');
    expect(res.text).toContain('type="password"');
  });

  it('POST /unlock with the correct password sets a scoped cookie and a follow-up GET redirects', async () => {
    const { token } = await signupUser('redirect-password-correct');
    const link = await createLink(token, {
      destinationUrl: 'https://example.com/unlocked',
      password: 'the-real-password',
    });
    const agent = request.agent(app);

    const unlockRes = await agent
      .post(`/${link.shortCode}/unlock`)
      .send({ password: 'the-real-password' });

    expect(unlockRes.status).toBe(302);
    expect(unlockRes.headers.location).toBe(`/${link.shortCode}`);
    const setCookie = unlockRes.headers['set-cookie'] as unknown as string[];
    expect(setCookie.some((c) => c.startsWith(`link_unlock_${link.shortCode}=`))).toBe(true);

    const followUp = await agent.get(`/${link.shortCode}`);
    expect(followUp.status).toBe(302);
    expect(followUp.headers.location).toBe('https://example.com/unlocked');
  });

  it('POST /unlock with the wrong password is rejected: 401, no valid grant issued', async () => {
    const { token } = await signupUser('redirect-password-wrong');
    const link = await createLink(token, {
      destinationUrl: 'https://example.com/gated',
      password: 'the-real-password',
    });

    const res = await request(app).post(`/${link.shortCode}/unlock`).send({ password: 'guess' });

    expect(res.status).toBe(401);
    expect(res.text).toContain('<form');

    const followUp = await request(app).get(`/${link.shortCode}`);
    expect(followUp.status).toBe(200);
    expect(followUp.headers.location).toBeUndefined();
  });

  it('CRITICAL: unlocking link A does not grant access to link B', async () => {
    const { token } = await signupUser('redirect-cross-link');
    const linkA = await createLink(token, {
      destinationUrl: 'https://example.com/a',
      password: 'password-a',
    });
    const linkB = await createLink(token, {
      destinationUrl: 'https://example.com/b',
      password: 'password-b',
    });

    const unlockA = await request(app)
      .post(`/${linkA.shortCode}/unlock`)
      .send({ password: 'password-a' });
    const tokenFromA = extractCookieValue(
      unlockA.headers['set-cookie'] as unknown as string[],
      `link_unlock_${linkA.shortCode}`,
    );

    // Forge a cookie *named* for link B but carrying link A's signed
    // grant — this is what actually proves verifyUnlockToken's
    // linkId comparison is the real enforcement, not just the cookie
    // naming convention (which alone wouldn't stop this exact attempt).
    const res = await request(app)
      .get(`/${linkB.shortCode}`)
      .set('Cookie', `link_unlock_${linkB.shortCode}=${tokenFromA}`);

    expect(res.status).toBe(200);
    expect(res.headers.location).toBeUndefined();
    expect(res.text).toContain('<form');
  });
});

describe('response caching (Redis)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('first request populates the Redis cache entry for the link', async () => {
    const { token } = await signupUser('cache-populate');
    const link = await createLink(token, { destinationUrl: 'https://example.com/cache-populate' });

    expect(await redis.get(`link:${link.shortCode}`)).toBeNull();

    const res = await request(app).get(`/${link.shortCode}`);
    expect(res.status).toBe(302);

    const cached = await redis.get(`link:${link.shortCode}`);
    expect(cached).not.toBeNull();
    const parsed = JSON.parse(cached!) as { id: string; destinationUrl: string };
    expect(parsed.id).toBe(link.id);
    expect(parsed.destinationUrl).toBe(link.destinationUrl);
  });

  it('a nonexistent short code is negative-cached with the miss sentinel', async () => {
    const code = `no-such-code-${Date.now()}`;

    const res = await request(app).get(`/${code}`);
    expect(res.status).toBe(404);

    expect(await redis.get(`link:${code}`)).toBe('__MISS__');
  });

  it('PATCH invalidates the cache: an immediate re-request reflects the new destination', async () => {
    const { token } = await signupUser('cache-patch-invalidate');
    const link = await createLink(token, { destinationUrl: 'https://example.com/before-edit' });

    await request(app).get(`/${link.shortCode}`); // populates the cache
    expect(await redis.get(`link:${link.shortCode}`)).not.toBeNull();

    await request(app)
      .patch(`/api/links/${link.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ destinationUrl: 'https://example.com/after-edit' });

    // Proves invalidation itself, not just that the follow-up request
    // happens to see fresh data despite a stale cache entry.
    expect(await redis.get(`link:${link.shortCode}`)).toBeNull();

    const res = await request(app).get(`/${link.shortCode}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://example.com/after-edit');
  });

  it('DELETE invalidates the cache: an immediate re-request is 404, not served from a stale entry', async () => {
    const { token } = await signupUser('cache-delete-invalidate');
    const link = await createLink(token, { destinationUrl: 'https://example.com/to-be-deleted' });

    await request(app).get(`/${link.shortCode}`); // populates the cache
    expect(await redis.get(`link:${link.shortCode}`)).not.toBeNull();

    await request(app).delete(`/api/links/${link.id}`).set('Authorization', `Bearer ${token}`);

    expect(await redis.get(`link:${link.shortCode}`)).toBeNull();

    const res = await request(app).get(`/${link.shortCode}`);
    expect(res.status).toBe(404);
  });

  it('falls back to Postgres when Redis GET fails', async () => {
    const { token } = await signupUser('cache-redis-get-down');
    const link = await createLink(token, { destinationUrl: 'https://example.com/redis-get-down' });

    vi.spyOn(redis, 'get').mockRejectedValueOnce(new Error('simulated Redis outage'));

    const res = await request(app).get(`/${link.shortCode}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://example.com/redis-get-down');
  });

  it('falls back gracefully when Redis SET fails while populating the cache', async () => {
    const { token } = await signupUser('cache-redis-set-down');
    const link = await createLink(token, { destinationUrl: 'https://example.com/redis-set-down' });

    vi.spyOn(redis, 'set').mockRejectedValueOnce(new Error('simulated Redis outage'));

    const res = await request(app).get(`/${link.shortCode}`);
    expect(res.status).toBe(302);

    // The failed write means nothing got cached — not that a stale/partial
    // entry was left behind.
    expect(await redis.get(`link:${link.shortCode}`)).toBeNull();
  });

  it('falls back gracefully when Redis DEL fails during invalidation', async () => {
    const { token } = await signupUser('cache-redis-del-down');
    const link = await createLink(token, { destinationUrl: 'https://example.com/redis-del-down' });

    await request(app).get(`/${link.shortCode}`); // populates the cache

    vi.spyOn(redis, 'del').mockRejectedValueOnce(new Error('simulated Redis outage'));

    const res = await request(app)
      .patch(`/api/links/${link.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ destinationUrl: 'https://example.com/redis-del-down-after' });

    // A failed cache invalidation must not fail the write request itself.
    expect(res.status).toBe(200);
  });

  it('a link with maxClicks set is cached with a much shorter TTL than an uncapped link', async () => {
    const { token } = await signupUser('cache-capped-ttl');
    const link = await createLink(token, {
      destinationUrl: 'https://example.com/capped-ttl',
      maxClicks: 5,
    });

    await request(app).get(`/${link.shortCode}`);

    const ttl = await redis.ttl(`link:${link.shortCode}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(5);
  });

  it('a capped link can overshoot its click limit within the short cache TTL, then self-corrects', async () => {
    const { token } = await signupUser('cache-capped-overshoot');
    const link = await createLink(token, {
      destinationUrl: 'https://example.com/overshoot',
      maxClicks: 1,
    });

    // Cache miss: reads click_count=0 from Postgres (0 < 1, live), caches
    // that pre-increment value with the 5s capped TTL. The click job is
    // then processed directly (standing in for the worker), bumping the
    // real count to 1 — the cached entry doesn't know that happened.
    const first = await getAndProcessClick(link.shortCode);
    expect(first.status).toBe(302);

    // Cache hit, still within the TTL: still sees the stale click_count=0
    // cached above, so it's served again even though the real count is
    // already at the cap. This is the accepted, documented overshoot —
    // not a bug. click_count's overshoot bound now compounds with queue-
    // processing lag too (see Notes.md, "Phase 9: Background Jobs"), but
    // this test isolates the cache-TTL component specifically, matching
    // Phase 8's original assertion.
    const second = await request(app).get(`/${link.shortCode}`);
    expect(second.status).toBe(302);

    // Wait out the 5s capped TTL so the next lookup is a genuine cache miss.
    await new Promise((resolve) => setTimeout(resolve, 6000));

    // Fresh read: click_count now reflects both prior clicks and is >= maxClicks.
    const third = await request(app).get(`/${link.shortCode}`);
    expect(third.status).toBe(410);
  }, 15000);

  it('dead-state checks are identical whether the entry is a cache hit or a cache miss', async () => {
    const { token } = await signupUser('cache-dead-state-consistency');
    const link = await createLink(token, { destinationUrl: 'https://example.com/dead-state' });
    await request(app)
      .patch(`/api/links/${link.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ isActive: false });

    const cold = await request(app).get(`/${link.shortCode}`); // cache miss
    expect(cold.status).toBe(410);

    const warm = await request(app).get(`/${link.shortCode}`); // cache hit
    expect(warm.status).toBe(410);
  });

  it('a password-protected link served from a warm cache still requires the unlock cookie, and unlocking still works', async () => {
    const { token } = await signupUser('cache-password-warm');
    const link = await createLink(token, {
      destinationUrl: 'https://example.com/warm-gated',
      password: 'warm-cache-password',
    });

    const cold = await request(app).get(`/${link.shortCode}`); // cache miss
    expect(cold.status).toBe(200);
    expect(cold.text).toContain('<form');

    const warm = await request(app).get(`/${link.shortCode}`); // cache hit
    expect(warm.status).toBe(200);
    expect(warm.text).toContain('<form');

    const agent = request.agent(app);
    const unlockRes = await agent
      .post(`/${link.shortCode}/unlock`)
      .send({ password: 'warm-cache-password' });
    expect(unlockRes.status).toBe(302);

    const followUp = await agent.get(`/${link.shortCode}`);
    expect(followUp.status).toBe(302);
    expect(followUp.headers.location).toBe('https://example.com/warm-gated');
  });
});

describe('scheduled cleanup — the dead-state message transition', () => {
  it('an expired link reads "This link has expired" before the sweep runs, "This link has been deactivated" after', async () => {
    // Introduced by Phase 9's scheduled sweep (worker/processors/
    // linkCleanupProcessor.ts): once the sweep flips is_active for an
    // expired link, deadStateError's is_active branch fires before its
    // expires_at branch, changing the message text. Deliberate and
    // expected — see Notes.md, "Phase 9: Background Jobs" / "Scheduled
    // cleanup" — not a regression, but worth asserting explicitly rather
    // than leaving as an implicit surprise.
    const { token } = await signupUser('redirect-sweep-transition');
    const link = await createLink(token, {
      destinationUrl: 'https://example.com/sweep-transition',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    await query("UPDATE links SET expires_at = now() - interval '1 hour' WHERE id = $1", [link.id]);

    const before = await request(app).get(`/${link.shortCode}`);
    expect(before.status).toBe(410);
    expect(before.body.error.message).toBe('This link has expired');

    await sweepExpiredLinks();
    // The GET above cached the pre-sweep row (is_active: true) with the
    // normal 300s TTL — cleared explicitly here to isolate this assertion
    // from Phase 8's cache-staleness window, which is covered separately.
    await redis.del(`link:${link.shortCode}`);

    const after = await request(app).get(`/${link.shortCode}`);
    expect(after.status).toBe(410);
    expect(after.body.error.message).toBe('This link has been deactivated');
  });
});

describe('route ordering — the redirect router must not shadow real routes', () => {
  it('GET /health still returns the real health-check response, not a link lookup', async () => {
    const res = await request(app).get('/health');

    expect(res.body.error).toBeUndefined();
    expect(res.body.checks).toBeDefined();
  });

  it('GET /api/links (unauthenticated) still returns 401 from requireAuth, not a link lookup', async () => {
    const res = await request(app).get('/api/links');

    expect(res.status).toBe(401);
  });
});
