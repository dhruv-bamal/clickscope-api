import { beforeAll, describe, expect, it } from 'vitest';

// src/services/passwordService.ts imports src/config/index.ts, which reads
// process.env at module-evaluation time — same reasoning as
// tests/routes/health.test.ts: loadEnvFile must run before this module (or
// anything importing it) is evaluated, so the import has to be dynamic,
// inside beforeAll, not static at the top of this file.
let hashPassword: typeof import('../../src/services/passwordService.js').hashPassword;
let verifyPassword: typeof import('../../src/services/passwordService.js').verifyPassword;
let DUMMY_PASSWORD_HASH: string;
let verifyAgainstDummyHash: typeof import('../../src/services/passwordService.js').verifyAgainstDummyHash;

beforeAll(async () => {
  process.loadEnvFile('.env.test');
  ({ hashPassword, verifyPassword, DUMMY_PASSWORD_HASH, verifyAgainstDummyHash } =
    await import('../../src/services/passwordService.js'));
});

describe('passwordService', () => {
  it('produces a different hash each time for the same password (salt is working)', async () => {
    const [hashA, hashB] = await Promise.all([
      hashPassword('correct horse battery staple'),
      hashPassword('correct horse battery staple'),
    ]);

    expect(hashA).not.toBe(hashB);
    expect(hashA).toMatch(/^\$2[aby]\$/);
    expect(hashB).toMatch(/^\$2[aby]\$/);
  });

  it('verifies successfully against the correct password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    await expect(verifyPassword('correct horse battery staple', hash)).resolves.toBe(true);
  });

  it('fails to verify against the wrong password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    await expect(verifyPassword('wrong password', hash)).resolves.toBe(false);
  });

  it('DUMMY_PASSWORD_HASH is a well-formed bcrypt hash', () => {
    expect(DUMMY_PASSWORD_HASH).toMatch(/^\$2[aby]\$/);
  });

  it('verifyAgainstDummyHash resolves to false for arbitrary input without throwing', async () => {
    await expect(verifyAgainstDummyHash('anything at all')).resolves.toBe(false);
  });
});
