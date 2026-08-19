# Phase 11: Database Optimization — findings

Measurement-driven indexing pass. Every index in `migrations/*_add-performance-indexes.ts` is justified by a captured `EXPLAIN ANALYZE` plan showing the problem it fixes, run against realistic, non-uniform seeded data (`scripts/seed-bulk.ts`: ~500 users, ~50,000 links, ~494,000 clicks, Zipf-skewed click distribution). No index was added speculatively — see "Rejected" below for what was considered and turned down.

Full raw plans: [`before.md`](./before.md) (pre-migration) and [`after.md`](./after.md) (post-migration). This file is the summary.

## Before/after summary

| Query | Before | After | Delta | Index added |
|---|---|---|---|---|
| Redirect lookup (`getLinkByShortCode`) | 0.135 ms, Index Scan | 0.062 ms, Index Scan (unchanged) | — | none — already served by `links_short_code_key` |
| Link list rows (`listLinks`) | 0.391 ms, Sort + Bitmap Heap Scan | 0.072 ms, Index Scan, no Sort | **~5.4x faster** | `links_user_id_created_at_id_index` |
| Link list count (`listLinks`) | 0.135 ms, Index Only Scan | 0.129 ms, Index Only Scan | ~unchanged | none needed — no `ORDER BY` to serve |
| Cleanup sweep (`sweepExpiredLinks`) | 24.478 ms, Seq Scan (50,000 rows) | 14.123 ms, Bitmap Index Scan (1,441 rows) | **~1.7x faster** | `links_expires_at_active_partial_index` |
| Click aggregation, bounded 30d (`getLinkClickStats`) | 8.457 ms, Filter-after-fetch + Sort | 2.868 ms, Index Cond + Sort | **~2.9x faster** | `clicks_link_id_clicked_at_index` |
| Click aggregation, unbounded | 16.091 ms | 14.369 ms | only ~11% faster — see `after.md` | same index, weaker benefit here |

**Write-cost check** (`processClickJob`, n=1,000 transactions, mixed hot/cold links):

| | p50 | p95 | mean | max |
|---|---|---|---|---|
| Before | 0.647 ms | 0.896 ms | 0.719 ms | 9.974 ms |
| After | 0.654 ms | 0.836 ms | 0.693 ms | 2.971 ms |

No measurable regression at this scale — the new `clicks(link_id, clicked_at)` index's per-insert maintenance cost is real in principle but too small to distinguish from run-to-run noise at ~494k rows / 1,000 sample transactions. See `after.md` for the full discussion of why this isn't "indexes are free."

## Indexes added

| Index | Table | Columns | Type | Serves |
|---|---|---|---|---|
| `links_user_id_created_at_id_index` | `links` | `(user_id, created_at DESC, id DESC)` | composite | `listLinks` rows query — `user_id` leftmost for the equality predicate, `created_at DESC, id DESC` matches the `ORDER BY` exactly so no separate sort is needed |
| `links_expires_at_active_partial_index` | `links` | `(expires_at) WHERE is_active = true` | partial | `sweepExpiredLinks` — `is_active` is low-selectivity so a full index on it wouldn't earn its keep; keying on `expires_at` within the `is_active = true` subset is what's actually selective, and rows drop out of the index the moment they're swept |
| `clicks_link_id_clicked_at_index` | `clicks` | `(link_id, clicked_at)` | composite | `getLinkClickStats` — `link_id` leftmost for the JOIN's equality predicate, `clicked_at` second lets the bounded `?days=N` range filter run inside the index instead of as a post-fetch `Filter` |

Both composites also fully subsume an existing single-column FK-support index (`links_user_id_index`, `clicks_link_id_index` respectively — same leftmost column), so both were dropped and replaced in the same migration rather than kept alongside the new ones. This was proven, not assumed: see the "drop-and-replace proof queries" in `after.md` — a bare `WHERE user_id = $1` filter, a bare `WHERE link_id = $1` filter, and (the highest-stakes check) a real `DELETE FROM users WHERE id = $1` FK cascade, confirmed still using the composite index and not falling back to a `Seq Scan`.

## Rejected

- **`clicks.clicked_at` alone, non-composite.** Nothing in the codebase queries `clicked_at` without filtering `link_id` first — an index whose leftmost column nothing filters on alone gets zero planner use while still paying full write-time maintenance cost.
- **`links.is_active` alone, full (non-partial).** Low selectivity (most rows are active at any given time) makes a full index on it unlikely to ever beat a sequential scan. The partial `(expires_at) WHERE is_active = true` sidesteps this by keying on the genuinely selective column within the small active subset.
- **`INCLUDE`/covering columns** on any of the three indexes above. No query is proven index-only-scan-worthy enough at this data volume to justify the extra size/write cost speculatively — the classic "might help later" mistake this whole phase's methodology exists to avoid.
- **A separate index on `links.max_clicks`.** Nothing queries by it — cap checks read an already-fetched row's field in application code, never `WHERE max_clicks ...`.

## N+1 audit

Searched every loop construct (`for`, `for...of`, `forEach`, `.map`) across `src/` and `worker/`. **No N+1 pattern exists.** The only loops present are a bounded short-code-collision retry (`linkService.ts`, at most `MAX_GENERATION_ATTEMPTS` = 5 single-row INSERT attempts, not a per-row fan-out over a result set) and in-memory `.map()` transforms of already-fetched rows (e.g. `rowsResult.rows.map(toLink)`). This is a confirmed absence, not an unchecked gap — see `Notes.md`, "Phase 11" for the general explanation of what an N+1 is and why this codebase's query-per-request-not-per-row discipline avoided introducing one.

## Connection pool review

Evidence gathered against the seeded workload, not a re-guessed heuristic number — see `scripts/bench/poolLoadTest.ts` (API pool) and `scripts/bench/workerPoolLoadTest.ts` (worker pool).

**API pool (`max: 10`).** 500 concurrent `listLinks` calls (1,000 actual queries — `listLinks` issues 2 in parallel per call), fired as a single synchronous burst against 500 distinct real seeded users:

| Run | Total duration | Peak `waitingCount` at dispatch | Max `waitingCount` across the run |
|---|---|---|---|
| 1 | 83.67 ms | 1,001 | 1,001 |
| 2 | 81.66 ms | 1,001 | 1,001 |
| 3 | 81.89 ms | 1,001 | 1,001 |

`pg_stat_activity` mid-run: 1 `active`, 9 `idle` (the pool's other connections had already finished their queries and returned to idle by the time the snapshot query ran — Postgres queries here are sub-millisecond, so a 10-connection pool churns through a 1,000-query backlog fast enough that most of it is "idle, waiting for the next batch" rather than "active" at any single instant).

**Finding, not a guess: yes, real queueing occurs** — `waitingCount` peaks at 1,001 immediately after dispatch, confirming `max: 10` is genuinely the bottleneck for a true all-at-once burst of this size. But the practical impact is small: the entire 1,000-query backlog still drains in ~82ms, because each individual query is sub-millisecond (per `before.md`/`after.md`) — the queueing is real but the queue drains fast enough that it wouldn't be user-visible at this data volume. This is also a harsher test than realistic traffic: 500 users' requests landing in the exact same event-loop tick is an adversarial pattern a real HTTP server wouldn't produce (arrivals are spread over wall-clock time, not batched).

**Worker pool (`max: 10`, `Worker` concurrency configured to 5).** A 200-job burst of `processClickJob` (40x the configured concurrency, deliberately adversarial):

```
totalDurationMs: 70.55
peakWaitingCountAtDispatch: 201
maxWaitingCountAcrossAllSamples: 191
pg_stat_activity: 1 active
```

Same shape: real queueing under a burst well beyond configured concurrency, drained in ~71ms.

**Conclusion: `max: 10` holds for both pools at this data volume and these burst sizes** — this is a measured finding, not an assumption. Neither pool showed a queue that failed to drain quickly, and `pg_stat_activity` never showed connections stuck in `idle in transaction` (the pathology `withTransaction`'s try/finally already guards against) during either run. If real production traffic ever shows a sustained (not just momentary-burst) `waitingCount > 0`, or `idle in transaction` connections that don't clear, that would be the actual evidence needed to revisit `max: 10` — not felt intuition about "500 users sounds like it needs more."

## How to reproduce

```
docker compose up -d
npm run migrate:down   # if the new migration is already applied, roll back for a clean before-state
npm run seed:bulk -- --reset
# capture before.md's EXPLAIN ANALYZE queries here
npm run migrate:up
docker exec <postgres-container> psql -U clickscope -d clickscope -c "VACUUM users, links, clicks;"
# capture after.md's EXPLAIN ANALYZE queries here
npx tsx --env-file=.env scripts/bench/clickWriteBench.ts       # write-path benchmark
npx tsx --env-file=.env scripts/bench/poolLoadTest.ts           # API pool review
npx tsx --env-file=.env scripts/bench/workerPoolLoadTest.ts     # worker pool review
```

Before/after captures must bracket exactly one migration apply with no re-seed in between — `seed:bulk --reset` truncates and regenerates all three tables with fresh random data, which would invalidate the row-for-row comparison (the "before" and "after" plans wouldn't be looking at the same rows anymore).

## What to investigate next with real production traffic

- **Actual query frequency and latency distribution**, not synthetic bursts — this phase's load tests are deliberately adversarial (an all-at-once burst) to find a ceiling, not a realistic traffic simulation. Real request arrival patterns (spread over time, not batched) would give a truer picture of steady-state pool utilization.
- **The estimated/actual row divergence on the cleanup sweep** (planner estimated 289 matching rows, actually found 1,441 — see `before.md`) — worth watching whether this divergence grows as the `is_active`/`expires_at` correlation in real data drifts further from what column-level statistics can capture; a growing divergence could eventually mislead the planner into a worse plan than `EXPLAIN` currently predicts.
- **Whether `GET /api/links/:id/stats`'s unbounded case ever gets used in practice** despite being clamped to 365 days by default — if usage patterns show most callers hitting the 365-day ceiling regularly (not just the 30-day default), that's evidence for reconsidering the default/max split, not just the index.
- **Real click-volume growth on `clicks`** — the current 494k-row table is a reasonable proxy for "moderate production scale," but if click volume grows an order of magnitude, revisit whether the composite index alone still suffices or whether table partitioning (by `clicked_at`, e.g. monthly) becomes worth its own operational complexity.
- **Sustained (not burst) `pg_stat_activity` monitoring in production**, ideally wired into existing observability rather than a one-off script — this phase's pool findings are a point-in-time measurement against seeded data, not continuous production evidence.
