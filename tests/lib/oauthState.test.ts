import { beforeAll, describe, expect, it } from 'vitest';

// oauthState transitively imports src/lib/redis.js -> src/config/index.js,
// same dynamic-import-after-loadEnvFile requirement as every file touching
// src/config. Runs against the real Redis instance from .env.test, not a
// mock — this is the smallest unit above the raw redis client itself.
let generateState: typeof import('../../src/lib/oauthState.js').generateState;
let storeState: typeof import('../../src/lib/oauthState.js').storeState;
let consumeState: typeof import('../../src/lib/oauthState.js').consumeState;

beforeAll(async () => {
  process.loadEnvFile('.env.test');
  ({ generateState, storeState, consumeState } = await import('../../src/lib/oauthState.js'));
});

describe('oauthState', () => {
  it('generateState produces distinct, non-empty values', () => {
    const a = generateState();
    const b = generateState();

    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it('a stored state is consumed successfully exactly once', async () => {
    const state = generateState();
    await storeState(state);

    expect(await consumeState(state)).toBe(true);
  });

  it('consuming the same state twice fails the second time (single-use, replay fails)', async () => {
    const state = generateState();
    await storeState(state);

    expect(await consumeState(state)).toBe(true);
    expect(await consumeState(state)).toBe(false);
  });

  it('a state that was never stored is rejected', async () => {
    const neverStored = generateState();
    expect(await consumeState(neverStored)).toBe(false);
  });
});
