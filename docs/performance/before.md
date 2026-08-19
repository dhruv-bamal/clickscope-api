# Phase 11 — Before measurements

Captured against a local Postgres 16 (Docker), seeded with `npm run seed:bulk -- --reset`, **before** the `add-performance-indexes` migration was applied. All plans are `EXPLAIN (ANALYZE, BUFFERS)` — `BUFFERS` matters specifically to distinguish `shared hit` (already in Postgres's buffer cache) from `shared read` (a real disk/page-cache read), i.e. whether a scan is warm or genuinely I/O-bound.

## Seeded data

```
users: 500
links: 50,000
clicks: 494,028   (target was 500,000 — jitter in the Zipf assignment; see scripts/seed-bulk.ts)
```

Click distribution (the whole point of seeding non-uniformly): `maxClickCount = 45,728`, `avgClickCount = 9.88` — a ~4,600x ratio between the hottest link and the average link. This is the shape that makes any of the following plans meaningful; see `scripts/seed-bulk.ts`'s module comment for why a uniform seed would have hidden this entirely (every link's row-count estimate would be flat, so there'd be no case where a `Seq Scan` is visibly expensive on one link and cheap on another).

Representative parameters picked from the seeded data itself:

| Role | id | detail |
|---|---|---|
| Hottest link | `8bbc8cc3-274c-4cc2-a446-2956dfbd7358` (`bulk-qgw`) | click_count = 45,728 |
| Coldest link | `590e9061-9adb-4829-af2e-39fbacf9c651` (`bulk-4`) | click_count = 1 |
| Busiest user | `9011ba9f-9fd9-426e-8416-c30e0d6f3c8d` | 1,058 links |

Existing indexes at this point (pre-migration): `links_pkey`, `links_short_code_key`, `links_user_id_index`, `clicks_pkey`, `clicks_link_id_index`, `clicks_job_id_unique`, plus the `users` indexes (unaffected by this phase).

---

## 1. Redirect lookup — `getLinkByShortCode` (`linkService.ts:517`)

```sql
SELECT id, destination_url, password_hash, expires_at, max_clicks, click_count, is_active
FROM links WHERE short_code = 'bulk-qgw';
```

```
Index Scan using links_short_code_key on links  (cost=0.41..8.43 rows=1 width=124) (actual time=0.083..0.084 rows=1 loops=1)
  Index Cond: (short_code = 'bulk-qgw'::text)
  Buffers: shared hit=1 read=3
Planning:
  Buffers: shared hit=114
Planning Time: 0.320 ms
Execution Time: 0.135 ms
```

**What this shows.** Already an `Index Scan` on the unique constraint's own index — this query was never a target for a new index, and the plan confirms it. Estimated rows (1) matches actual rows (1) exactly, as expected for an equality lookup on a unique column. 0.135ms execution — and remember this only runs on a Redis cache miss at all (Phase 8), so the real per-request frequency of this exact plan is lower than "every redirect."

## 2. Link list — rows (`listLinks`, `linkService.ts:196`)

```sql
SELECT <LINK_COLUMNS> FROM links
WHERE user_id = '9011ba9f-9fd9-426e-8416-c30e0d6f3c8d'
ORDER BY created_at DESC, id DESC LIMIT 20 OFFSET 0;
```

```
Limit  (cost=949.65..949.70 rows=20 width=105) (actual time=0.351..0.354 rows=20 loops=1)
  Buffers: shared hit=25 read=2
  ->  Sort  (cost=949.65..952.38 rows=1092 width=105) (actual time=0.350..0.351 rows=20 loops=1)
        Sort Key: created_at DESC, id DESC
        Sort Method: top-N heapsort  Memory: 29kB
        Buffers: shared hit=25 read=2
        ->  Bitmap Heap Scan on links  (cost=16.75..920.59 rows=1092 width=105) (actual time=0.048..0.186 rows=1058 loops=1)
              Recheck Cond: (user_id = '9011ba9f-9fd9-426e-8416-c30e0d6f3c8d'::uuid)
              Heap Blocks: exact=19
              Buffers: shared hit=19 read=2
              ->  Bitmap Index Scan on links_user_id_index  (cost=0.00..16.48 rows=1092 width=0) (actual time=0.031..0.031 rows=1058 loops=1)
                    Index Cond: (user_id = '9011ba9f-9fd9-426e-8416-c30e0d6f3c8d'::uuid)
                    Buffers: shared read=2
Planning:
  Buffers: shared hit=174 read=1
Planning Time: 0.370 ms
Execution Time: 0.391 ms
```

**What this shows.** Reading inside-out: the innermost `Bitmap Index Scan` uses the existing `links_user_id_index` to find this user's 1,058 rows efficiently — that part is already fine. But there's a `Sort` node above it (`Sort Key: created_at DESC, id DESC`) — the index only tells Postgres *which* rows match, not what order they're in, so the whole matching set (1,058 rows) has to be fetched and sorted before the `LIMIT 20` can be applied. Estimated 1,092 rows vs actual 1,058 — close, not a divergence worth flagging. At this data size the sort is cheap (top-N heapsort, 29kB, sub-millisecond) — the point of the composite index isn't fixing a slow query today, it's removing a step (the `Sort` node) that would stop being cheap as `total pages` per user grows, and that's exactly what `after.md` should show disappearing.

## 3. Link list — count (`listLinks`, `linkService.ts:203`)

```sql
SELECT count(*)::int AS count FROM links WHERE user_id = '9011ba9f-9fd9-426e-8416-c30e0d6f3c8d';
```

```
Aggregate  (cost=30.13..30.14 rows=1 width=4) (actual time=0.103..0.103 rows=1 loops=1)
  Buffers: shared hit=3
  ->  Index Only Scan using links_user_id_index on links  (cost=0.29..27.40 rows=1092 width=0) (actual time=0.019..0.064 rows=1058 loops=1)
        Index Cond: (user_id = '9011ba9f-9fd9-426e-8416-c30e0d6f3c8d'::uuid)
        Heap Fetches: 0
        Buffers: shared hit=3
Planning:
  Buffers: shared hit=125
Planning Time: 0.210 ms
Execution Time: 0.135 ms
```

**What this shows.** Already optimal: an `Index Only Scan` (`Heap Fetches: 0` — every value needed came straight from the index, no heap access at all) on `links_user_id_index`. This query has no `ORDER BY` to satisfy, so it doesn't benefit from the new composite index's extra columns — it's already as fast as an index can make it, and the new composite serves it exactly as well (same leftmost column) but no better.

## 4. Cleanup sweep — `sweepExpiredLinks` (`linkCleanupProcessor.ts:31`)

Run inside `BEGIN; ... ROLLBACK;` so the real predicate (not a `false`-shortcircuited stand-in — Postgres constant-folds `AND false` into a zero-cost no-op plan, which defeats the point) executes for real without mutating seeded data:

```sql
UPDATE links SET is_active = false, updated_at = now()
WHERE is_active = true AND expires_at IS NOT NULL AND expires_at <= now();
```

```
Update on links  (cost=0.00..1595.72 rows=0 width=0) (actual time=24.444..24.444 rows=0 loops=1)
  Buffers: shared hit=19989 read=389 dirtied=419 written=30
  ->  Seq Scan on links  (cost=0.00..1595.72 rows=289 width=15) (actual time=0.011..4.150 rows=1441 loops=1)
        Filter: (is_active AND (expires_at IS NOT NULL) AND (expires_at <= now()))
        Rows Removed by Filter: 48559
        Buffers: shared hit=845
Planning:
  Buffers: shared hit=95
Planning Time: 0.265 ms
Execution Time: 24.478 ms
```

**What this shows.** A full `Seq Scan` over all 50,000 links, filtering row-by-row — `Rows Removed by Filter: 48559` against only 1,441 matches is the plan explicitly telling you 97% of the scan's work was wasted. Estimated rows (289) vs actual (1,441) diverges by ~5x — a real, flaggable divergence (the planner's statistics don't capture the correlation between `is_active` and `expires_at` well from column-level stats alone), though not the reason this needs an index; the `Seq Scan` itself is reason enough. 24.478ms for a 60-second-interval background job is not urgent today, but it's the clearest "no index, doing more work than it needs to" case in this set, and it's the one that would scale worst as link volume grows, since a `Seq Scan`'s cost is linear in table size regardless of how selective the predicate is.

## 5a. Click aggregation — bounded 30-day range (`getLinkClickStats`, hottest link)

```sql
SELECT date_trunc('day', c.clicked_at) AS day, count(*)::int AS clicks
FROM clicks c JOIN links l ON l.id = c.link_id
WHERE l.id = '8bbc8cc3-274c-4cc2-a446-2956dfbd7358'
  AND l.user_id = '1d38be02-59ea-45e9-bb24-2748fff0ef95'
  AND c.clicked_at >= now() - interval '30 days'
GROUP BY day ORDER BY day;
```

```
GroupAggregate  (cost=12764.50..12934.26 rows=7545 width=12) (actual time=7.880..8.393 rows=31 loops=1)
  Group Key: (date_trunc('day'::text, c.clicked_at))
  Buffers: shared hit=993 read=36
  ->  Sort  (cost=12764.50..12783.36 rows=7545 width=8) (actual time=7.872..8.080 rows=7393 loops=1)
        Sort Key: (date_trunc('day'::text, c.clicked_at))
        Sort Method: quicksort  Memory: 193kB
        Buffers: shared hit=993 read=36
        ->  Nested Loop  (cost=634.86..12278.55 rows=7545 width=8) (actual time=0.842..7.431 rows=7393 loops=1)
              Buffers: shared hit=990 read=36
              ->  Index Scan using links_pkey on links l  (cost=0.29..8.31 rows=1 width=16) (actual time=0.018..0.019 rows=1 loops=1)
                    Index Cond: (id = '8bbc8cc3-274c-4cc2-a446-2956dfbd7358'::uuid)
                    Filter: (user_id = '1d38be02-59ea-45e9-bb24-2748fff0ef95'::uuid)
                    Buffers: shared hit=3
              ->  Bitmap Heap Scan on clicks c  (cost=634.57..12175.93 rows=7545 width=24) (actual time=0.806..6.489 rows=7393 loops=1)
                    Recheck Cond: (link_id = '8bbc8cc3-274c-4cc2-a446-2956dfbd7358'::uuid)
                    Filter: (clicked_at >= (now() - '30 days'::interval))
                    Rows Removed by Filter: 38335
                    Heap Blocks: exact=985
                    Buffers: shared hit=987 read=36
                    ->  Bitmap Index Scan on clicks_link_id_index  (cost=0.00..632.68 rows=45368 width=0) (actual time=0.713..0.713 rows=45728 loops=1)
                          Index Cond: (link_id = '8bbc8cc3-274c-4cc2-a446-2956dfbd7358'::uuid)
                          Buffers: shared hit=2 read=36
Planning:
  Buffers: shared hit=209 read=1
Planning Time: 0.456 ms
Execution Time: 8.457 ms
```

**What this shows.** The existing single-column `clicks_link_id_index` finds all 45,728 of this link's clicks via a `Bitmap Index Scan` — but then the 30-day range filter has to be applied as a row-by-row `Filter` *after* fetching them (`Rows Removed by Filter: 38335` — 84% of the fetched rows get thrown away), because `clicked_at` isn't part of the index. On top of that, a `Sort` node (193kB, 7,393 rows) is needed for the `GROUP BY`, since nothing about the scan's output order matches `date_trunc('day', clicked_at)`. 8.457ms total on the hottest link in the dataset — this is exactly the case a `(link_id, clicked_at)` composite should fix on both fronts: filter the range inside the index instead of after, and (if clicked_at ordering is preserved through the scan) reduce or eliminate the sort.

## 5b. Click aggregation — unbounded full history (hottest link)

Same query, `clicked_at >= '1970-01-01'` instead of a 30-day bound — included specifically to show whether the composite index's second column (`clicked_at`) earns its keep, or whether the range-filtering benefit only shows up in the bounded case.

```
GroupAggregate  (cost=16042.64..17063.33 rows=45364 width=12) (actual time=12.946..16.029 rows=182 loops=1)
  Group Key: (date_trunc('day'::text, c.clicked_at))
  Buffers: shared hit=1029
  ->  Sort  (cost=16042.64..16156.05 rows=45364 width=8) (actual time=12.938..14.204 rows=45728 loops=1)
        Sort Key: (date_trunc('day'::text, c.clicked_at))
        Sort Method: quicksort  Memory: 1537kB
        Buffers: shared hit=1029
        ->  Nested Loop  (cost=644.31..12533.90 rows=45364 width=8) (actual time=0.727..9.846 rows=45728 loops=1)
              Buffers: shared hit=1026
              ->  Index Scan using links_pkey on links l  (cost=0.29..8.31 rows=1 width=16) (actual time=0.019..0.020 rows=1 loops=1)
                    Index Cond: (id = '8bbc8cc3-274c-4cc2-a446-2956dfbd7358'::uuid)
                    Filter: (user_id = '1d38be02-59ea-45e9-bb24-2748fff0ef95'::uuid)
                    Buffers: shared hit=3
              ->  Bitmap Heap Scan on clicks c  (cost=644.02..11958.54 rows=45364 width=24) (actual time=0.704..4.407 rows=45728 loops=1)
                    Recheck Cond: (link_id = '8bbc8cc3-274c-4cc2-a446-2956dfbd7358'::uuid)
                    Filter: (clicked_at >= '1970-01-01 00:00:00+00'::timestamp with time zone)
                    Heap Blocks: exact=985
                    Buffers: shared hit=1023
                    ->  Bitmap Index Scan on clicks_link_id_index  (cost=0.00..632.68 rows=45368 width=0) (actual time=0.610..0.610 rows=45728 loops=1)
                          Index Cond: (link_id = '8bbc8cc3-274c-4cc2-a446-2956dfbd7358'::uuid)
                          Buffers: shared hit=38
Planning:
  Buffers: shared hit=210
Planning Time: 0.331 ms
Execution Time: 16.091 ms
```

**What this shows.** No range filter to skip here (the `clicked_at >= '1970-01-01'` filter matches everything), so the only cost is fetching and sorting all 45,728 rows for the `GROUP BY` — 16.091ms, roughly double the bounded case, dominated by the 1,537kB quicksort over every row. This is the case that isolates whether `clicked_at`'s presence as the *second* index key (letting the scan come out pre-ordered) matters even when there's no range to filter — `after.md` should show whether the `Sort` node shrinks or disappears here too.

---

## Write-path benchmark — click insert + click_count update

`processClickJob` (`worker/processors/clickProcessor.ts`) run directly (not through BullMQ) for 1,000 synthetic jobs, mixed across the 5 hottest links, 5 coldest links, and 20 random links from the seeded set — `process.hrtime.bigint()` timing per transaction, same pattern already used in `redirect.ts`'s enqueue timing.

```json
{"n":1000,"p50Ms":0.647,"p95Ms":0.896,"meanMs":0.719,"maxMs":9.974}
```

This is the baseline the `after.md` write-cost comparison is measured against — expected to move slightly *higher* once the new `clicks(link_id, clicked_at)` index exists, since every `INSERT` now maintains one more index.

---

## Summary table

| Query | Plan (top node) | Rows scanned vs. returned | Execution time |
|---|---|---|---|
| Redirect lookup | Index Scan (`links_short_code_key`) | 1 / 1 | 0.135 ms |
| Link list rows | Sort → Bitmap Heap Scan (`links_user_id_index`) | 1,058 / 20 | 0.391 ms |
| Link list count | Index Only Scan (`links_user_id_index`) | 1,058 / 1 | 0.135 ms |
| Cleanup sweep | **Seq Scan** (50,000 rows) | 1,441 matched / 48,559 rejected | 24.478 ms |
| Click aggregation (30d) | Sort → Bitmap Heap Scan (`clicks_link_id_index`) | 45,728 fetched / 7,393 kept | 8.457 ms |
| Click aggregation (unbounded) | Sort → Bitmap Heap Scan (`clicks_link_id_index`) | 45,728 / 45,728 | 16.091 ms |

**Flagged estimate/actual divergence:** the cleanup sweep's `Seq Scan` estimated 289 matching rows but actually found 1,441 (~5x) — the planner's per-column statistics can't capture the correlation between `is_active = true` and `expires_at <= now()`, so it under-estimates how many rows satisfy both together. This doesn't change the fix (a `Seq Scan` needs an index regardless of how good the row estimate is), but it's a real signal worth naming: if this correlation drifted further in production data, plans that look fine on paper (low estimated cost) could still be doing much more work in practice than the estimate suggests.
