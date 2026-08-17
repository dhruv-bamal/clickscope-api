import type { Express } from 'express';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

let app: Express;
let query: typeof import('../../src/db/pool.js').query;

beforeAll(async () => {
  // Same dynamic-import-after-loadEnvFile requirement as tests/routes/links.test.ts —
  // src/app.ts transitively imports src/config at module-evaluation time.
  process.loadEnvFile('.env.test');
  ({ app } = await import('../../src/app.js'));
  ({ query } = await import('../../src/db/pool.js'));
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
  const res = await request(app).post('/api/links').set('Authorization', `Bearer ${token}`).send(body);
  return res.body.link as { id: string; shortCode: string; destinationUrl: string };
}

/** Pulls one cookie's raw value out of a supertest response's Set-Cookie header(s). */
function extractCookieValue(setCookie: string[] | undefined, name: string): string {
  const line = (setCookie ?? []).find((c) => c.startsWith(`${name}=`));
  if (!line) throw new Error(`Cookie "${name}" not found in Set-Cookie header(s): ${JSON.stringify(setCookie)}`);
  return line.slice(`${name}=`.length).split(';')[0]!;
}

describe('GET /:shortCode — valid link', () => {
  it('redirects with 302 and the correct Location header', async () => {
    const { token } = await signupUser('redirect-valid');
    const link = await createLink(token, { destinationUrl: 'https://example.com/destination' });

    const res = await request(app).get(`/${link.shortCode}`);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://example.com/destination');
  });

  it('records a click: one row in clicks, click_count incremented by 1', async () => {
    const { token } = await signupUser('redirect-records-click');
    const link = await createLink(token, { destinationUrl: 'https://example.com/tracked' });

    await request(app)
      .get(`/${link.shortCode}`)
      .set('Referer', 'https://referrer.example.com/page')
      .set('User-Agent', 'redirect-test-agent/1.0');

    const clicks = await query<{ link_id: string; referrer: string | null; user_agent: string | null }>(
      'SELECT link_id, referrer, user_agent FROM clicks WHERE link_id = $1',
      [link.id],
    );
    expect(clicks.rows).toHaveLength(1);
    expect(clicks.rows[0]?.referrer).toBe('https://referrer.example.com/page');
    expect(clicks.rows[0]?.user_agent).toBe('redirect-test-agent/1.0');

    const stored = await query<{ click_count: number }>('SELECT click_count FROM links WHERE id = $1', [
      link.id,
    ]);
    expect(stored.rows[0]?.click_count).toBe(1);
  });

  it('handles a missing referrer/user-agent gracefully (stored as NULL, not an error)', async () => {
    const { token } = await signupUser('redirect-no-headers');
    const link = await createLink(token, { destinationUrl: 'https://example.com/no-headers' });

    const res = await request(app).get(`/${link.shortCode}`).unset('User-Agent');

    expect(res.status).toBe(302);
    const clicks = await query<{ referrer: string | null; user_agent: string | null }>(
      'SELECT referrer, user_agent FROM clicks WHERE link_id = $1',
      [link.id],
    );
    expect(clicks.rows[0]?.referrer).toBeNull();
  });

  it('concurrent redirects to the same link do not lose clicks', async () => {
    const { token } = await signupUser('redirect-concurrent');
    const link = await createLink(token, { destinationUrl: 'https://example.com/concurrent' });
    const CONCURRENCY = 20;

    await Promise.all(
      Array.from({ length: CONCURRENCY }, () => request(app).get(`/${link.shortCode}`)),
    );

    const stored = await query<{ click_count: number }>('SELECT click_count FROM links WHERE id = $1', [
      link.id,
    ]);
    expect(stored.rows[0]?.click_count).toBe(CONCURRENCY);

    const clicks = await query('SELECT id FROM clicks WHERE link_id = $1', [link.id]);
    expect(clicks.rows).toHaveLength(CONCURRENCY);
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
    await query('UPDATE links SET expires_at = now() - interval \'1 hour\' WHERE id = $1', [link.id]);

    const res = await request(app).get(`/${link.shortCode}`);

    expect(res.status).toBe(410);
  });

  it('returns 410 once click_count reaches maxClicks', async () => {
    const { token } = await signupUser('redirect-maxclicks');
    const link = await createLink(token, { destinationUrl: 'https://example.com/limited', maxClicks: 1 });

    const first = await request(app).get(`/${link.shortCode}`);
    expect(first.status).toBe(302);

    const second = await request(app).get(`/${link.shortCode}`);
    expect(second.status).toBe(410);
  });
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

    const unlockRes = await agent.post(`/${link.shortCode}/unlock`).send({ password: 'the-real-password' });

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
    const linkA = await createLink(token, { destinationUrl: 'https://example.com/a', password: 'password-a' });
    const linkB = await createLink(token, { destinationUrl: 'https://example.com/b', password: 'password-b' });

    const unlockA = await request(app).post(`/${linkA.shortCode}/unlock`).send({ password: 'password-a' });
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
