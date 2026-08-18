/**
 * The wire contract between this process (producer, via src/queues/) and
 * the worker process (consumer, via worker/) — queue names and job payload
 * shapes, and nothing else. Deliberately the one file worker/ imports from
 * src/, rather than each process hand-maintaining its own copy: a typo in
 * a duplicated queue-name string (`'click-recording'` vs `'clickRecording'`)
 * would silently create two disjoint, empty queues with no error at all,
 * since Redis just treats them as two unrelated key namespaces. One shared,
 * side-effect-free module lets `tsc` catch that kind of drift at compile
 * time instead. See Notes.md, "Phase 9: Background Jobs."
 */

export const CLICK_QUEUE_NAME = 'click-recording';
export const LINK_CLEANUP_QUEUE_NAME = 'link-cleanup';

export const LINK_CLEANUP_SCHEDULER_ID = 'sweep-expired-links';
export const LINK_CLEANUP_JOB_NAME = 'sweep-expired-links';

/**
 * `clickId` is generated once by the producer (redirect.ts) and reused as
 * both the BullMQ jobId (enqueue-level dedup) and the `clicks.job_id`
 * unique-constraint value (processing-level dedup) — see the idempotency
 * writeup in Notes.md, "Phase 9: Background Jobs."
 */
export interface ClickJobData {
  clickId: string;
  linkId: string;
  shortCode: string;
  referrer: string | null;
  userAgent: string | null;
}
