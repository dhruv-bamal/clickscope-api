import type { Queue } from 'bullmq';
import { LINK_CLEANUP_JOB_NAME, LINK_CLEANUP_SCHEDULER_ID } from '../src/queues/contracts.js';
import { logger } from './logger.js';

/**
 * Every 60 seconds — frequent enough that an expired link's is_active flag
 * flips promptly (and that this is easy to observe in local dev without a
 * long wait), infrequent enough that a single UPDATE scanning is_active/
 * expires_at (deliberately not indexed yet — see the links migration's own
 * comment and Notes.md, "Phase 9: Background Jobs" / "Scheduled cleanup")
 * is a complete non-issue at this project's scale. A starting point, not a
 * tuned production interval — deployment/scheduling config is explicitly
 * out of scope for this phase.
 */
const SWEEP_INTERVAL_MS = 60_000;

/**
 * Registers the repeatable expired-link sweep. Safe to call from every
 * worker instance at boot: `upsertJobScheduler` is explicitly designed to
 * upsert the schedule definition keyed on `schedulerId` rather than create
 * a new one each call, so N worker replicas all calling this at startup
 * with the same id/pattern converge to exactly one active schedule — the
 * 2nd through Nth calls are no-ops by BullMQ's own design.
 *
 * This is one of two layers guarding against duplicate scheduling; the
 * other is that sweepExpiredLinks' SQL is independently idempotent even if
 * this layer somehow produced more than one active schedule. See Notes.md,
 * "Phase 9: Background Jobs" / "Scheduled cleanup" for why both are used
 * deliberately rather than relying on either alone.
 */
export async function registerLinkCleanupScheduler(queue: Queue): Promise<void> {
  await queue.upsertJobScheduler(
    LINK_CLEANUP_SCHEDULER_ID,
    { every: SWEEP_INTERVAL_MS },
    { name: LINK_CLEANUP_JOB_NAME },
  );

  logger.info(
    { schedulerId: LINK_CLEANUP_SCHEDULER_ID, intervalMs: SWEEP_INTERVAL_MS },
    'Registered link cleanup scheduler',
  );
}
