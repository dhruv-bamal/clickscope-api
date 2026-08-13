import { beforeAll, describe, expect, it } from 'vitest';

// authService transitively imports src/config (via src/db/pool.js and
// src/services/passwordService.js/tokenService.js) — same
// dynamic-import-after-loadEnvFile requirement as every file touching
// src/config. This suite runs against the real clickscope_test database
// (see tests/globalSetup.ts), not a mock.
let signup: typeof import('../../src/services/authService.js').signup;
let login: typeof import('../../src/services/authService.js').login;
let getUserById: typeof import('../../src/services/authService.js').getUserById;
let query: typeof import('../../src/db/pool.js').query;
let AppError: typeof import('../../src/lib/errors.js').AppError;

beforeAll(async () => {
  process.loadEnvFile('.env.test');
  ({ signup, login, getUserById } = await import('../../src/services/authService.js'));
  ({ query } = await import('../../src/db/pool.js'));
  ({ AppError } = await import('../../src/lib/errors.js'));
});

// authService writes through the shared pool (not a dedicated pg.Client),
// so the BEGIN/ROLLBACK-per-test isolation used in tests/db/constraints.test.ts
// doesn't apply here — pooled queries may land on different connections.
// Unique emails per test keep rows from colliding instead; nothing else in
// this suite queries `users` without a WHERE clause, so leftover rows are
// harmless within a single test run.
function uniqueEmail(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

describe('authService.signup', () => {
  it('creates a user with a bcrypt password hash, never plaintext', async () => {
    const email = uniqueEmail('signup-hash');
    const { user, token } = await signup(email, 'a-plaintext-password');

    expect(user.email).toBe(email);
    expect(user).not.toHaveProperty('password_hash');
    expect(user).not.toHaveProperty('passwordHash');
    expect(typeof token).toBe('string');

    const stored = await query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = $1',
      [user.id],
    );
    expect(stored.rows[0]?.password_hash).toMatch(/^\$2[aby]\$/);
    expect(stored.rows[0]?.password_hash).not.toBe('a-plaintext-password');
  });

  it('rejects a duplicate email with 409', async () => {
    const email = uniqueEmail('signup-dup');
    await signup(email, 'password-one');

    await expect(signup(email, 'password-two')).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it('rejects a duplicate email that only differs in case with 409 (proves the lower(email) index)', async () => {
    const base = uniqueEmail('signup-case');
    const upper = base.toUpperCase();

    await signup(base, 'password-one');

    await expect(signup(upper, 'password-two')).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it('thrown errors are AppError instances', async () => {
    const email = uniqueEmail('signup-apperror');
    await signup(email, 'password-one');

    await expect(signup(email, 'password-two')).rejects.toBeInstanceOf(AppError);
  });
});

describe('authService.login', () => {
  it('succeeds with correct credentials', async () => {
    const email = uniqueEmail('login-ok');
    await signup(email, 'correct-password');

    const { user, token } = await login(email, 'correct-password');

    expect(user.email).toBe(email);
    expect(typeof token).toBe('string');
  });

  it('login is case-insensitive on email', async () => {
    const email = uniqueEmail('login-case');
    await signup(email, 'correct-password');

    const { user } = await login(email.toUpperCase(), 'correct-password');
    expect(user.email).toBe(email);
  });

  it('wrong password and nonexistent email produce IDENTICAL 401 errors', async () => {
    const email = uniqueEmail('login-wrongpw');
    await signup(email, 'correct-password');

    const wrongPasswordError = await login(email, 'incorrect-password').catch(
      (err: unknown) => err,
    );
    const noSuchUserError = await login(uniqueEmail('login-nouser'), 'anything').catch(
      (err: unknown) => err,
    );

    expect(wrongPasswordError).toMatchObject({ statusCode: 401 });
    expect(noSuchUserError).toMatchObject({ statusCode: 401 });
    expect((wrongPasswordError as { message: string }).message).toBe(
      (noSuchUserError as { message: string }).message,
    );
  });
});

describe('authService.getUserById', () => {
  it('returns the shaped user for an existing id', async () => {
    const email = uniqueEmail('getbyid-hit');
    const { user } = await signup(email, 'a-password');

    const found = await getUserById(user.id);
    expect(found).toEqual(user);
  });

  it('returns null for a nonexistent id', async () => {
    const found = await getUserById('00000000-0000-0000-0000-000000000000');
    expect(found).toBeNull();
  });
});
