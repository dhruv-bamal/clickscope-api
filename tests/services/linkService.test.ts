import { beforeAll, describe, expect, it, vi } from 'vitest';

// generateShortCode is mocked (delegating to the real implementation by
// default) so the collision-retry tests can force a specific code
// deterministically instead of hoping for a real random collision.
vi.mock('../../src/lib/shortCode.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/shortCode.js')>();
  return { ...actual, generateShortCode: vi.fn(actual.generateShortCode) };
});

// linkService transitively imports src/db/pool.js -> src/config/index.js,
// same dynamic-import-after-loadEnvFile requirement as every file touching
// src/config. Runs against the real clickscope_test database.
let createLink: typeof import('../../src/services/linkService.js').createLink;
let listLinks: typeof import('../../src/services/linkService.js').listLinks;
let getLink: typeof import('../../src/services/linkService.js').getLink;
let updateLink: typeof import('../../src/services/linkService.js').updateLink;
let deleteLink: typeof import('../../src/services/linkService.js').deleteLink;
let getLinkByShortCode: typeof import('../../src/services/linkService.js').getLinkByShortCode;
let signup: typeof import('../../src/services/authService.js').signup;
let query: typeof import('../../src/db/pool.js').query;
let AppError: typeof import('../../src/lib/errors.js').AppError;
let verifyPassword: typeof import('../../src/services/passwordService.js').verifyPassword;
let generateShortCode: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  process.loadEnvFile('.env.test');
  ({ createLink, listLinks, getLink, updateLink, deleteLink, getLinkByShortCode } = await import(
    '../../src/services/linkService.js'
  ));
  ({ signup } = await import('../../src/services/authService.js'));
  ({ query } = await import('../../src/db/pool.js'));
  ({ AppError } = await import('../../src/lib/errors.js'));
  ({ verifyPassword } = await import('../../src/services/passwordService.js'));
  const shortCode = await import('../../src/lib/shortCode.js');
  generateShortCode = shortCode.generateShortCode as unknown as ReturnType<typeof vi.fn>;
});

function uniqueEmail(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

function uniqueAlias(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function createUser(label: string) {
  const { user } = await signup(uniqueEmail(label), 'a-password');
  return user;
}

describe('linkService.createLink', () => {
  it('creates a link with a generated short code', async () => {
    const user = await createUser('create-generated');

    const link = await createLink(user.id, { destinationUrl: 'https://example.com/generated' });

    expect(link.userId).toBe(user.id);
    expect(link.destinationUrl).toBe('https://example.com/generated');
    expect(link.shortCode).toMatch(/^[0-9A-Za-z]{7}$/);
    expect(link.clickCount).toBe(0);
    expect(link.isActive).toBe(true);
  });

  it('creates a link with a custom alias', async () => {
    const user = await createUser('create-alias');
    const alias = uniqueAlias('custom');

    const link = await createLink(user.id, {
      destinationUrl: 'https://example.com/alias',
      customAlias: alias,
    });

    expect(link.shortCode).toBe(alias);
  });

  it('rejects a duplicate custom alias with 409, even across two different users', async () => {
    const userA = await createUser('dup-alias-a');
    const userB = await createUser('dup-alias-b');
    const alias = uniqueAlias('taken');

    await createLink(userA.id, { destinationUrl: 'https://example.com/first', customAlias: alias });

    await expect(
      createLink(userB.id, { destinationUrl: 'https://example.com/second', customAlias: alias }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('thrown conflict errors are AppError instances', async () => {
    const user = await createUser('conflict-apperror');
    const alias = uniqueAlias('apperror');
    await createLink(user.id, { destinationUrl: 'https://example.com/one', customAlias: alias });

    await expect(
      createLink(user.id, { destinationUrl: 'https://example.com/two', customAlias: alias }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('retries with a fresh code when the generated code collides, and succeeds', async () => {
    const user = await createUser('collision-retry');
    const collidingCode = uniqueAlias('collide').slice(0, 20);
    const freshCode = uniqueAlias('fresh').slice(0, 20);

    // Occupy `collidingCode` directly, bypassing generateShortCode entirely,
    // so the first generated attempt below is guaranteed to hit a real
    // 23505 on insert rather than relying on a coincidental collision.
    await query('INSERT INTO links (user_id, short_code, destination_url) VALUES ($1, $2, $3)', [
      user.id,
      collidingCode,
      'https://example.com/occupied',
    ]);

    generateShortCode.mockReturnValueOnce(collidingCode).mockReturnValueOnce(freshCode);
    // Clears accumulated call history from earlier tests in this file
    // (shared module-level mock) without touching the queued return
    // values just set above, so the call-count assertion below reflects
    // only this test's createLink invocation.
    generateShortCode.mockClear();

    const link = await createLink(user.id, { destinationUrl: 'https://example.com/retried' });

    expect(link.shortCode).toBe(freshCode);
    expect(generateShortCode).toHaveBeenCalledTimes(2);
  });

  it('fails loudly after exhausting all generation attempts', async () => {
    const user = await createUser('collision-exhausted');
    const collidingCode = uniqueAlias('stuck').slice(0, 20);

    await query('INSERT INTO links (user_id, short_code, destination_url) VALUES ($1, $2, $3)', [
      user.id,
      collidingCode,
      'https://example.com/occupied',
    ]);

    // mockReturnValueOnce x5 (not mockReturnValue) deliberately — a
    // permanent override would keep returning this now-occupied code for
    // every later test in this file that creates a link without a custom
    // alias, since the mock is shared module state. Once the "once" queue
    // is exhausted, calls fall through to the real generator again.
    generateShortCode
      .mockReturnValueOnce(collidingCode)
      .mockReturnValueOnce(collidingCode)
      .mockReturnValueOnce(collidingCode)
      .mockReturnValueOnce(collidingCode)
      .mockReturnValueOnce(collidingCode);
    generateShortCode.mockClear();

    await expect(
      createLink(user.id, { destinationUrl: 'https://example.com/never' }),
    ).rejects.toMatchObject({ statusCode: 500 });
    expect(generateShortCode).toHaveBeenCalledTimes(5);
  });

  it('creates a link without a password: isPasswordProtected is false, password_hash is NULL', async () => {
    const user = await createUser('create-no-password');
    const link = await createLink(user.id, { destinationUrl: 'https://example.com/open' });

    expect(link.isPasswordProtected).toBe(false);

    const stored = await query<{ password_hash: string | null }>(
      'SELECT password_hash FROM links WHERE id = $1',
      [link.id],
    );
    expect(stored.rows[0]?.password_hash).toBeNull();
  });

  it('creates a link with a password: isPasswordProtected is true, the stored hash is bcrypt (not the plaintext)', async () => {
    const user = await createUser('create-password');
    const link = await createLink(user.id, {
      destinationUrl: 'https://example.com/gated',
      password: 'a-link-password',
    });

    expect(link.isPasswordProtected).toBe(true);
    expect(link).not.toHaveProperty('passwordHash');
    expect(link).not.toHaveProperty('password_hash');

    const stored = await query<{ password_hash: string | null }>(
      'SELECT password_hash FROM links WHERE id = $1',
      [link.id],
    );
    expect(stored.rows[0]?.password_hash).toMatch(/^\$2[aby]\$/);
    expect(stored.rows[0]?.password_hash).not.toBe('a-link-password');
  });
});

describe('linkService.getLink', () => {
  it('returns the link for its owner', async () => {
    const user = await createUser('get-owner');
    const created = await createLink(user.id, { destinationUrl: 'https://example.com/mine' });

    const found = await getLink(user.id, created.id);
    expect(found).toEqual(created);
  });

  it('returns null when the link belongs to another user (object-level authorization)', async () => {
    const owner = await createUser('get-owner-2');
    const attacker = await createUser('get-attacker');
    const created = await createLink(owner.id, { destinationUrl: 'https://example.com/theirs' });

    const found = await getLink(attacker.id, created.id);
    expect(found).toBeNull();
  });

  it('returns null for a nonexistent id', async () => {
    const user = await createUser('get-nonexistent');
    const found = await getLink(user.id, '00000000-0000-0000-0000-000000000000');
    expect(found).toBeNull();
  });
});

describe('linkService.listLinks', () => {
  it("never includes another user's links", async () => {
    const userA = await createUser('list-a');
    const userB = await createUser('list-b');

    await createLink(userA.id, { destinationUrl: 'https://example.com/a1' });
    await createLink(userB.id, { destinationUrl: 'https://example.com/b1' });
    await createLink(userB.id, { destinationUrl: 'https://example.com/b2' });

    const { links, total } = await listLinks(userA.id, { limit: 20, offset: 0 });

    expect(total).toBe(1);
    expect(links).toHaveLength(1);
    expect(links.every((link) => link.userId === userA.id)).toBe(true);
  });

  it('paginates correctly across two pages', async () => {
    const user = await createUser('list-pagination');
    for (let i = 0; i < 5; i += 1) {
      await createLink(user.id, { destinationUrl: `https://example.com/page-${i}` });
    }

    const firstPage = await listLinks(user.id, { limit: 3, offset: 0 });
    const secondPage = await listLinks(user.id, { limit: 3, offset: 3 });

    expect(firstPage.total).toBe(5);
    expect(firstPage.links).toHaveLength(3);
    expect(secondPage.links).toHaveLength(2);

    const firstPageIds = new Set(firstPage.links.map((link) => link.id));
    const overlap = secondPage.links.filter((link) => firstPageIds.has(link.id));
    expect(overlap).toHaveLength(0);
  });
});

describe('linkService.updateLink', () => {
  it('leaves fields absent from the input unchanged', async () => {
    const user = await createUser('update-partial');
    const created = await createLink(user.id, {
      destinationUrl: 'https://example.com/original',
      maxClicks: 10,
    });

    const updated = await updateLink(user.id, created.id, { destinationUrl: 'https://example.com/changed' });

    expect(updated?.destinationUrl).toBe('https://example.com/changed');
    expect(updated?.maxClicks).toBe(10);
  });

  it('explicit null clears a nullable field', async () => {
    const user = await createUser('update-clear');
    const created = await createLink(user.id, {
      destinationUrl: 'https://example.com/original',
      maxClicks: 10,
    });

    const updated = await updateLink(user.id, created.id, { maxClicks: null });

    expect(updated?.maxClicks).toBeNull();
  });

  it('an empty input is a no-op that returns the link unchanged', async () => {
    const user = await createUser('update-empty');
    const created = await createLink(user.id, { destinationUrl: 'https://example.com/noop' });

    const updated = await updateLink(user.id, created.id, {});

    expect(updated).toEqual(created);
  });

  it("returns null and leaves the row untouched when attempted by a non-owner (object-level authorization)", async () => {
    const owner = await createUser('update-owner');
    const attacker = await createUser('update-attacker');
    const created = await createLink(owner.id, { destinationUrl: 'https://example.com/theirs' });

    const result = await updateLink(attacker.id, created.id, {
      destinationUrl: 'https://example.com/hijacked',
    });
    expect(result).toBeNull();

    const stored = await query<{ destination_url: string }>(
      'SELECT destination_url FROM links WHERE id = $1',
      [created.id],
    );
    expect(stored.rows[0]?.destination_url).toBe('https://example.com/theirs');
  });

  it('sets a password on a previously open link', async () => {
    const user = await createUser('update-set-password');
    const created = await createLink(user.id, { destinationUrl: 'https://example.com/open' });
    expect(created.isPasswordProtected).toBe(false);

    const updated = await updateLink(user.id, created.id, { password: 'new-password' });

    expect(updated?.isPasswordProtected).toBe(true);
  });

  it('explicit null clears a password', async () => {
    const user = await createUser('update-clear-password');
    const created = await createLink(user.id, {
      destinationUrl: 'https://example.com/gated',
      password: 'original-password',
    });

    const updated = await updateLink(user.id, created.id, { password: null });

    expect(updated?.isPasswordProtected).toBe(false);
    const stored = await query<{ password_hash: string | null }>(
      'SELECT password_hash FROM links WHERE id = $1',
      [created.id],
    );
    expect(stored.rows[0]?.password_hash).toBeNull();
  });

  it('leaves the password unchanged when the key is absent from the input', async () => {
    const user = await createUser('update-password-unchanged');
    const created = await createLink(user.id, {
      destinationUrl: 'https://example.com/gated',
      password: 'stays-the-same',
    });
    const before = await query<{ password_hash: string | null }>(
      'SELECT password_hash FROM links WHERE id = $1',
      [created.id],
    );

    const updated = await updateLink(user.id, created.id, { destinationUrl: 'https://example.com/moved' });

    expect(updated?.isPasswordProtected).toBe(true);
    const after = await query<{ password_hash: string | null }>(
      'SELECT password_hash FROM links WHERE id = $1',
      [created.id],
    );
    expect(after.rows[0]?.password_hash).toBe(before.rows[0]?.password_hash);
  });
});

describe('linkService.getLinkByShortCode', () => {
  it('returns null for a nonexistent short code', async () => {
    const found = await getLinkByShortCode(uniqueAlias('nonexistent'));
    expect(found).toBeNull();
  });

  it('is not scoped to any owner — the redirect route has no authenticated user to scope by', async () => {
    const user = await createUser('lookup-unscoped');
    const created = await createLink(user.id, { destinationUrl: 'https://example.com/public' });

    const found = await getLinkByShortCode(created.shortCode);

    expect(found?.id).toBe(created.id);
    expect(found?.destinationUrl).toBe('https://example.com/public');
  });

  it('returns a usable raw password_hash for a protected link', async () => {
    const user = await createUser('lookup-password');
    const created = await createLink(user.id, {
      destinationUrl: 'https://example.com/gated',
      password: 'the-real-password',
    });

    const found = await getLinkByShortCode(created.shortCode);

    expect(found?.passwordHash).not.toBeNull();
    await expect(verifyPassword('the-real-password', found!.passwordHash!)).resolves.toBe(true);
    await expect(verifyPassword('wrong-password', found!.passwordHash!)).resolves.toBe(false);
  });
});

describe('linkService.deleteLink', () => {
  it('deletes the link for its owner', async () => {
    const user = await createUser('delete-owner');
    const created = await createLink(user.id, { destinationUrl: 'https://example.com/todelete' });

    const deleted = await deleteLink(user.id, created.id);
    expect(deleted).toBe(true);

    const stored = await query('SELECT id FROM links WHERE id = $1', [created.id]);
    expect(stored.rows).toHaveLength(0);
  });

  it("returns false and leaves the row untouched when attempted by a non-owner (object-level authorization)", async () => {
    const owner = await createUser('delete-owner-2');
    const attacker = await createUser('delete-attacker');
    const created = await createLink(owner.id, { destinationUrl: 'https://example.com/theirs' });

    const deleted = await deleteLink(attacker.id, created.id);
    expect(deleted).toBe(false);

    const stored = await query('SELECT id FROM links WHERE id = $1', [created.id]);
    expect(stored.rows).toHaveLength(1);
  });
});
