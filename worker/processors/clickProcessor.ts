import type { ClickJobData } from '../../src/queues/contracts.js';
import { withTransaction } from '../db/pool.js';
import { logger } from '../logger.js';

/**
 * Processes one click job: inserts a `clicks` row and increments
 * `links.click_count`, idempotently.
 *
 * `INSERT ... ON CONFLICT (job_id) DO NOTHING` makes a duplicate-processed
 * job's insert a safe no-op instead of a second row — `job_id` carries the
 * same `clickId` the producer generated once at enqueue time (see
 * src/routes/redirect.ts), so two attempts at "the same" job always
 * collide on the same value. The `click_count` increment is conditioned on
 * `rowCount > 0`: if the insert didn't happen (this attempt is a duplicate),
 * the increment must not happen either, or a duplicate-processed job would
 * still double-count despite the harmless-looking insert.
 *
 * Both statements run inside one transaction (withTransaction, worker/
 * db/pool.ts) so a crash between the INSERT committing and the UPDATE
 * running can never happen — without the transaction, that specific crash
 * window would permanently under-count a click that genuinely was
 * recorded, which is exactly the failure mode this design exists to close.
 *
 * Exact residual risk (see Notes.md, "Phase 9: Background Jobs" /
 * "Idempotency" for the full writeup): this protects against duplicate
 * *processing* of a given clickId. It does not, and cannot, protect
 * against a producer bug that generates two different clickIds for what
 * should be one physical click — neither this function nor BullMQ has any
 * way to know two distinct UUIDs refer to "the same" real-world event.
 *
 * Generic job lifecycle logging (started/completed-with-duration/failed-
 * with-attempt-number) lives at the Worker level in worker/index.ts, not
 * here — this function only logs the one thing that's genuinely specific
 * to click processing: a duplicate job being skipped.
 */
export async function processClickJob(data: ClickJobData): Promise<void> {
  const log = logger.child({ clickId: data.clickId, linkId: data.linkId });

  await withTransaction(async (client) => {
    const inserted = await client.query(
      `INSERT INTO clicks (job_id, link_id, referrer, user_agent)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (job_id) DO NOTHING
       RETURNING id`,
      [data.clickId, data.linkId, data.referrer, data.userAgent],
    );

    if (inserted.rowCount === 0) {
      log.warn('Duplicate click job — skipping click_count increment');
      return;
    }

    await client.query('UPDATE links SET click_count = click_count + 1 WHERE id = $1', [
      data.linkId,
    ]);
  });
}
