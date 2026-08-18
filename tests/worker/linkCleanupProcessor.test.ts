import { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LINK_CLEANUP_QUEUE_NAME } from '../../src/queues/contracts.js';

let sweepExpiredLinks: typeof import('../../worker/processors/linkCleanupProcessor.js').sweepExpiredLinks;
let registerLinkCleanupScheduler: typeof import('../../worker/scheduler.js').registerLinkCleanupScheduler;
let workerRedis: typeof import('../../worker/redis.js').workerRedis;
let signup: typeof import('../../src/services/authService.js').signup;
let createLink: typeof import('../../src/services/linkService.js').createLink;
let query: typeof import('../../src/db/pool.js').query;

beforeAll(async () => {
  process.loadEnvFile('.env.test');
  ({ sweepExpiredLinks } = await import('../../worker/processors/linkCleanupProcessor.js'));
  ({ registerLinkCleanupScheduler } = await import('../../worker/scheduler.js'));
  ({ workerRedis } = await import('../../worker/redis.js'));
  ({ signup } = await import('../../src/services/authService.js'));
  ({ createLink } = await import('../../src/services/linkService.js'));
  ({ query } = await import('../../src/db/pool.js'));
});

function uniqueEmail(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

async function createTestLink(
  label: string,
  overrides: { expiresAt?: Date | null; isActive?: boolean } = {},
): Promise<{ id: string }> {
  const { user } = await signup(uniqueEmail(label), 'a-password');
  const link = await createLink(user.id, { destinationUrl: `https://example.com/${label}` });
  if (overrides.expiresAt !== undefined) {
    await query('UPDATE links SET expires_at = $2 WHERE id = $1', [link.id, overrides.expiresAt]);
  }
  if (overrides.isActive !== undefined) {
    await query('UPDATE links SET is_active = $2 WHERE id = $1', [link.id, overrides.isActive]);
  }
  return link;
}

async function isActive(linkId: string): Promise<boolean> {
  const result = await query<{ is_active: boolean }>('SELECT is_active FROM links WHERE id = $1', [
    linkId,
  ]);
  return result.rows[0]!.is_active;
}

describe('sweepExpiredLinks', () => {
  it('deactivates an expired-but-active link, twice in a row without error or double effect', async () => {
    const expired = await createTestLink('sweep-expired', {
      expiresAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    const notExpired = await createTestLink('sweep-not-expired', {
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    const alreadyInactive = await createTestLink('sweep-already-inactive', {
      expiresAt: new Date(Date.now() - 60 * 60 * 1000),
      isActive: false,
    });

    const first = await sweepExpiredLinks();
    expect(first.deactivated).toBeGreaterThanOrEqual(1);
    expect(await isActive(expired.id)).toBe(false);
    expect(await isActive(notExpired.id)).toBe(true);
    expect(await isActive(alreadyInactive.id)).toBe(false);

    // Idempotent: a second run touches nothing new. The expired link
    // already matched, and no longer does (is_active is already false), so
    // the un-expired link is still the only one left untouched.
    const second = await sweepExpiredLinks();
    expect(second.deactivated).toBe(0);
    expect(await isActive(notExpired.id)).toBe(true);
  });
});

describe('registerLinkCleanupScheduler', () => {
  const testQueue = new Queue(LINK_CLEANUP_QUEUE_NAME, { connection: workerRedis });

  afterAll(async () => {
    await testQueue.close();
  });

  it('calling it twice results in exactly one active scheduler, not two', async () => {
    await registerLinkCleanupScheduler(testQueue);
    await registerLinkCleanupScheduler(testQueue);

    const schedulers = await testQueue.getJobSchedulers();
    expect(schedulers).toHaveLength(1);
  });
});
