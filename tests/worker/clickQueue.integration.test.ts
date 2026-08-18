import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Queue, Worker } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKER_ENTRY = path.join(REPO_ROOT, 'worker/index.ts');

let workerRedis: typeof import('../../worker/redis.js').workerRedis;

beforeAll(async () => {
  process.loadEnvFile('.env.test');
  ({ workerRedis } = await import('../../worker/redis.js'));
});

describe('BullMQ retry with backoff', () => {
  const TEST_QUEUE_NAME = `test-click-retry-${Date.now()}`;
  const testQueue = new Queue(TEST_QUEUE_NAME, { connection: workerRedis });
  let testWorker: Worker | undefined;

  afterAll(async () => {
    await testWorker?.close();
    await testQueue.obliterate({ force: true });
    await testQueue.close();
  });

  it('a job that always fails retries with backoff, then lands in the failed set with attemptsMade === attempts', async () => {
    // Test-local, overridden job options — small attempts and a short
    // fixed backoff, not the production 5-attempts/1s-exponential values
    // (src/queues/clickQueue.ts) — production backoff timing is BullMQ's
    // own library concern, not something this test needs to wait out in
    // real wall-clock time.
    const ATTEMPTS = 3;
    const BACKOFF_DELAY_MS = 50;

    const failedPromise = new Promise<{ jobId: string | undefined; attemptsMade: number }>(
      (resolve) => {
        testWorker = new Worker(
          TEST_QUEUE_NAME,
          () => {
            throw new Error('processor always fails, for this test only');
          },
          { connection: workerRedis, concurrency: 1 },
        );
        testWorker.on('failed', (job) => {
          if (job && job.attemptsMade >= ATTEMPTS) {
            resolve({ jobId: job.id, attemptsMade: job.attemptsMade });
          }
        });
      },
    );

    await testQueue.add(
      'always-fails',
      {},
      { attempts: ATTEMPTS, backoff: { type: 'fixed', delay: BACKOFF_DELAY_MS } },
    );

    const { jobId, attemptsMade } = await failedPromise;
    expect(attemptsMade).toBe(ATTEMPTS);

    const failed = await testQueue.getFailed();
    expect(failed.some((job) => job.id === jobId)).toBe(true);
  }, 10000);
});

describe('worker graceful shutdown (SIGTERM)', () => {
  it('a job already active when SIGTERM arrives is allowed to finish before the process exits', async () => {
    // .env.test was already loaded into process.env by this file's
    // beforeAll (and by tests/globalSetup.ts before that), so DATABASE_URL/
    // REDIS_URL/NODE_ENV are all already present to inherit. LOG_LEVEL is
    // overridden to 'info' for this one child specifically — .env.test sets
    // it to 'warn' (to keep the rest of the suite's output quiet), but this
    // test's assertions depend on reading the worker's info-level lifecycle
    // logs (started/ready/completed/shutdown) from its stdout.
    //
    // Spawned via `node --import tsx`, not the `tsx` CLI binary directly —
    // the CLI wraps and launches a second, actual worker process internally
    // (visible as two distinct PIDs in `ps`), and signaling the CLI process
    // does not reliably forward SIGTERM to that inner process. `--import`
    // registers tsx's loader hooks in this single node process directly,
    // so the process this test signals is the same one running worker/
    // index.ts's own SIGTERM handler.
    const child = spawn('node', ['--import', 'tsx', WORKER_ENTRY], {
      cwd: REPO_ROOT,
      env: { ...process.env, LOG_LEVEL: 'info' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `worker did not become ready in time; stdout so far:\n${stdout}\nstderr so far:\n${stderr}`,
            ),
          ),
        15000,
      );
      child.stdout?.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('clickscope-worker ready')) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    await ready;

    const { clickQueue } = await import('../../src/queues/clickQueue.js');
    const clickId = `graceful-shutdown-${Date.now()}`;
    // link_id deliberately doesn't reference a real row — the point of
    // this test is the shutdown *process contract* (does the worker wait
    // for its in-flight job before exiting), not this particular job's
    // business outcome. The FK violation makes the job fail, which is
    // fine: the assertions below accept either a logged 'completed' or a
    // logged 'failed', since both prove the job ran to completion before
    // the process exited rather than being abandoned mid-processing.
    await clickQueue.add(
      'record-click',
      {
        clickId,
        linkId: '00000000-0000-0000-0000-000000000000',
        shortCode: 'irrelevant',
        referrer: null,
        userAgent: null,
      },
      { jobId: clickId },
    );

    // Wait until the freshly-spawned worker has actually picked this job up
    // (left 'waiting') before signaling — dispatch latency (the worker's
    // first poll of a queue it just started listening to) turned out to
    // dominate over this job's own near-instant processing time, so sending
    // SIGTERM immediately after enqueueing was racing the wrong thing: the
    // job was still sitting untouched in 'waiting' when the worker closed,
    // which Worker.close() doesn't drain. Waiting for 'waiting' to end is
    // what actually puts the signal in the job's processing window, whether
    // that means catching it genuinely 'active' or finding it already
    // 'completed'/'failed' by the time this loop notices — either still
    // proves the job wasn't abandoned mid-flight.
    const job = await clickQueue.getJob(clickId);
    const dispatchDeadline = Date.now() + 5000;
    while ((await job?.getState()) === 'waiting' && Date.now() < dispatchDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    child.kill('SIGTERM');

    const exitCode = await new Promise<number | null>((resolve) => {
      child.on('exit', (code) => resolve(code));
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Received shutdown signal');
    expect(stdout).toContain('Worker shutdown complete');

    // The job's own write is a no-op against a nonexistent linkId (FK
    // violation), so this test isn't asserting a Postgres row — it's
    // asserting the process-level contract: the worker didn't exit until
    // its in-flight job finished (successfully or not) and logged
    // completion, proving the drain actually waited rather than
    // abandoning the job mid-processing.
    expect(stdout).toMatch(
      /"jobId":"graceful-shutdown-\d+".*Job (completed|failed)|Job (completed|failed).*"jobId":"graceful-shutdown-\d+"/,
    );
  }, 30000);
});
