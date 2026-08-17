import { query } from '../db/pool.js';

export interface RecordClickInput {
  linkId: string;
  referrer: string | null;
  userAgent: string | null;
}

/**
 * Records one click: inserts a row into `clicks` and increments
 * `links.click_count`, as two separate statements — deliberately NOT
 * wrapped in a transaction. See Notes.md, "Phase 7: The Public Redirect"
 * / "Atomic increments vs. read-then-write" for the measured numbers
 * behind this call.
 *
 * Two distinct guarantees are at play here, and only one of them needs a
 * transaction:
 *
 *  1. No lost updates under concurrent redirects — guaranteed by
 *     `click_count = click_count + 1` being computed inside a single
 *     UPDATE statement, which Postgres executes atomically per row
 *     regardless of whether it's wrapped in an explicit transaction.
 *     This is the property the concurrency test in
 *     tests/routes/redirect.test.ts proves, and it holds either way.
 *  2. `clicks` and `click_count` never disagreeing even if the process
 *     crashes between the INSERT and the UPDATE — this is the one a
 *     transaction *would* add, at the cost of two extra network round
 *     trips (BEGIN, COMMIT) on every single redirect, the hottest path
 *     in the system. Benchmarked locally at roughly 1.5x the latency of
 *     the plain two-statement version (see Notes.md for the numbers).
 *
 * click_count is a denormalized cache of `clicks`, which remains the
 * source of truth — the only way the two could disagree here is a crash
 * landing in the sub-millisecond gap between the INSERT resolving and the
 * UPDATE being issued, and the only possible drift is click_count
 * under-counting by the small number of clicks that were mid-flight at
 * that instant (the INSERT runs first, so an UPDATE can never fire
 * without a corresponding row already committed — over-counting isn't
 * possible). That's a rare, self-limiting, and low-stakes risk to accept
 * on this path in exchange for the latency back — reconsider this
 * decision if click_count ever becomes a hard security/billing boundary
 * rather than a display counter.
 */
export async function recordClick(input: RecordClickInput): Promise<void> {
  await query('INSERT INTO clicks (link_id, referrer, user_agent) VALUES ($1, $2, $3)', [
    input.linkId,
    input.referrer,
    input.userAgent,
  ]);
  await query('UPDATE links SET click_count = click_count + 1 WHERE id = $1', [input.linkId]);
}
