# Phase 11 — After measurements

Same process as `before.md`, same seeded data (no re-seed in between — see the reproduction note in `README.md`), run **after** `npm run migrate:up` applied `add-performance-indexes`, followed by `VACUUM users, links, clicks;`.

**Why the extra `VACUUM`:** the first capture of query 3 (link list count) came back as a `Bitmap Heap Scan` instead of the expected `Index Only Scan`, even though the new composite index covers every column the query needs. Reason: `ANALYZE` refreshes the planner's row-count/statistics, but `Index Only Scan`'s ability to skip the heap entirely additionally depends on the table's **visibility map**, which only `VACUUM` populates. A freshly created index sits on a table whose visibility map hasn't been updated for the new index yet, so Postgres falls back to checking heap visibility per row until a `VACUUM` runs — in production this happens automatically via autovacuum, not instantly, but not indefinitely either. This is itself a real, worth-documenting methodology finding, not a workaround to bury: **`ANALYZE` alone does not guarantee a new index gets the fastest plan it's capable of; `VACUUM` is a second, separate prerequisite.** See `Notes.md`, "Phase 11" for the full writeup. All plans below are captured post-`VACUUM`, so they reflect the index's actual steady-state behavior, not its immediate post-creation transient.

Same seeded data, same representative parameters as `before.md`:

| Role | id | detail |
|---|---|---|
| Hottest link | `8bbc8cc3-274c-4cc2-a446-2956dfbd7358` (`bulk-qgw`) | click_count = 45,728 |
| Busiest user | `9011ba9f-9fd9-426e-8416-c30e0d6f3c8d` | 1,058 links |

---

## 1. Redirect lookup

```
Index Scan using links_short_code_key on links  (cost=0.41..8.43 rows=1 width=124) (actual time=0.026..0.037 rows=1 loops=1)
  Index Cond: (short_code = 'bulk-qgw'::text)
  Buffers: shared hit=6
Planning:
  Buffers: shared hit=138 read=2
Planning Time: 0.292 ms
Execution Time: 0.062 ms
```

**Unchanged, as expected** — this query was never a target. Same `Index Scan` on `links_short_code_key`, which this migration doesn't touch.

## 2. Link list — rows

```
Limit  (cost=0.41..50.88 rows=20 width=105) (actual time=0.041..0.059 rows=20 loops=1)
  Buffers: shared hit=19 read=3
  ->  Index Scan using links_user_id_created_at_id_index on links  (cost=0.41..2649.85 rows=1050 width=105) (actual time=0.040..0.056 rows=20 loops=1)
        Index Cond: (user_id = '9011ba9f-9fd9-426e-8416-c30e0d6f3c8d'::uuid)
        Buffers: shared hit=19 read=3
Planning:
  Buffers: shared hit=201
Planning Time: 0.299 ms
Execution Time: 0.072 ms
```

**The `Sort` node is gone.** `links_user_id_created_at_id_index` returns rows already in `created_at DESC, id DESC` order — the `Bitmap Heap Scan` + `Sort` (heapsort over 1,058 rows) from `before.md` is replaced by a single `Index Scan` that stops as soon as it has 20 rows (`cost=0.41..2649.85`, but the `Limit`'s actual cost is only 0.41..50.88 — Postgres doesn't need to scan the full estimated cost range once `LIMIT 20` is satisfied). **0.391ms → 0.072ms, ~5.4x faster.**

## 3. Link list — count

```
Aggregate  (cost=53.41..53.43 rows=1 width=4) (actual time=0.106..0.107 rows=1 loops=1)
  Buffers: shared hit=11
  ->  Index Only Scan using links_user_id_created_at_id_index on links  (cost=0.41..50.79 rows=1050 width=0) (actual time=0.015..0.077 rows=1058 loops=1)
        Index Cond: (user_id = '9011ba9f-9fd9-426e-8416-c30e0d6f3c8d'::uuid)
        Heap Fetches: 0
        Buffers: shared hit=11
Planning:
  Buffers: shared hit=151
Planning Time: 0.184 ms
Execution Time: 0.129 ms
```

**Essentially unchanged (0.135ms → 0.129ms)** — this query had no `ORDER BY` to benefit from, and both the old single-column index and the new composite serve a bare equality filter equally well as an `Index Only Scan`. Included for completeness, not because an improvement was expected.

## 4. Cleanup sweep

```
Update on links  (cost=7.25..607.54 rows=0 width=0) (actual time=14.090..14.091 rows=0 loops=1)
  Buffers: shared hit=21370 read=318 dirtied=349
  ->  Bitmap Heap Scan on links  (cost=7.25..607.54 rows=289 width=15) (actual time=0.245..1.254 rows=1441 loops=1)
        Recheck Cond: ((expires_at IS NOT NULL) AND (expires_at <= now()) AND is_active)
        Heap Blocks: exact=695
        Buffers: shared hit=695 read=5
        ->  Bitmap Index Scan on links_expires_at_active_partial_index (cost=0.00..7.18 rows=289 width=0) (actual time=0.186..0.186 rows=1441 loops=1)
              Index Cond: ((expires_at IS NOT NULL) AND (expires_at <= now()))
              Buffers: shared read=5
Planning:
  Buffers: shared hit=122
Planning Time: 0.257 ms
Execution Time: 14.123 ms
```

**`Seq Scan` → `Bitmap Index Scan` on the new partial index.** The scan itself now touches exactly the 1,441 matching rows instead of all 50,000 (`cost=7.25..607.54` vs. `0.00..1595.72` before — roughly 2.6x lower estimated cost). **Total execution time: 24.478ms → 14.123ms (~1.7x faster)**, a smaller win than the plan-shape change alone would suggest, because the `Update on links` node's own cost (`Buffers: shared hit=21370 ... dirtied=349` — the actual row-writing work) now dominates over the scan, which used to be the larger of the two costs. This is the honest shape of the improvement: the sweep no longer *reads* 50,000 rows to find 1,441, but *writing* those 1,441 rows was never free, and that part is unchanged either way.

## 5a. Click aggregation — bounded 30-day range

```
GroupAggregate  (cost=916.53..1090.75 rows=7743 width=12) (actual time=2.251..2.814 rows=31 loops=1)
  Group Key: (date_trunc('day'::text, c.clicked_at))
  Buffers: shared hit=7 read=40
  ->  Sort  (cost=916.53..935.89 rows=7743 width=8) (actual time=2.242..2.469 rows=7427 loops=1)
        Sort Key: (date_trunc('day'::text, c.clicked_at))
        Sort Method: quicksort  Memory: 193kB
        Buffers: shared hit=7 read=40
        ->  Nested Loop  (cost=0.72..416.38 rows=7743 width=8) (actual time=0.122..1.841 rows=7427 loops=1)
              Buffers: shared hit=4 read=40
              ->  Index Scan using links_pkey on links l  (cost=0.29..8.31 rows=1 width=16) (actual time=0.022..0.023 rows=1 loops=1)
                    Index Cond: (id = '8bbc8cc3-274c-4cc2-a446-2956dfbd7358'::uuid)
                    Filter: (user_id = '1d38be02-59ea-45e9-bb24-2748fff0ef95'::uuid)
                    Buffers: shared hit=3
              ->  Index Only Scan using clicks_link_id_clicked_at_index on clicks c  (cost=0.43..311.29 rows=7743 width=24) (actual time=0.092..0.944 rows=7427 loops=1)
                    Index Cond: ((link_id = '8bbc8cc3-274c-4cc2-a446-2956dfbd7358'::uuid) AND (clicked_at >= (now() - '30 days'::interval)))
                    Heap Fetches: 0
                    Buffers: shared hit=1 read=40
Planning:
  Buffers: shared hit=239
Planning Time: 0.608 ms
Execution Time: 2.868 ms
```

**The 30-day bound moved from a post-fetch `Filter` into the index condition itself.** `Index Cond: ((link_id = ...) AND (clicked_at >= ...))` now does both jobs in one index traversal — no more "Rows Removed by Filter: 38335" — and it's an `Index Only Scan` (`Heap Fetches: 0`), so the heap isn't touched at all. The `Sort` node is still present (`GROUP BY date_trunc('day', clicked_at)` is grouping on an expression, and Postgres doesn't infer that `clicked_at`'s index order also implies `date_trunc('day', clicked_at)`'s order, even though it mechanically does — this is a real limitation worth naming, not a bug), but it now sorts far fewer rows (7,427 vs the same rough count as before, just without the wasted fetch-then-discard step ahead of it). **8.457ms → 2.868ms, ~2.9x faster.**

## 5b. Click aggregation — unbounded full history

```
GroupAggregate  (cost=6039.62..7084.09 rows=46421 width=12) (actual time=11.325..14.302 rows=182 loops=1)
  Group Key: (date_trunc('day'::text, c.clicked_at))
  Buffers: shared hit=46 read=190
  ->  Sort  (cost=6039.62..6155.67 rows=46421 width=8) (actual time=11.316..12.586 rows=45762 loops=1)
        Sort Key: (date_trunc('day'::text, c.clicked_at))
        Sort Method: quicksort  Memory: 1537kB
        Buffers: shared hit=46 read=190
        ->  Nested Loop  (cost=0.71..2441.41 rows=46421 width=8) (actual time=0.072..9.347 rows=45762 loops=1)
              Buffers: shared hit=43 read=190
              ->  Index Scan using links_pkey on links l  (cost=0.29..8.31 rows=1 width=16) (actual time=0.014..0.015 rows=1 loops=1)
                    Index Cond: (id = '8bbc8cc3-274c-4cc2-a446-2956dfbd7358'::uuid)
                    Filter: (user_id = '1d38be02-59ea-45e9-bb24-2748fff0ef95'::uuid)
                    Buffers: shared hit=3
              ->  Index Only Scan using clicks_link_id_clicked_at_index on clicks c  (cost=0.42..1852.84 rows=46421 width=24) (actual time=0.054..4.463 rows=45762 loops=1)
                    Index Cond: ((link_id = '8bbc8cc3-274c-4cc2-a446-2956dfbd7358'::uuid) AND (clicked_at >= '1970-01-01 00:00:00+00'::timestamp with time zone))
                    Heap Fetches: 0
                    Buffers: shared hit=40 read=190
Planning:
  Buffers: shared hit=239
Planning Time: 0.360 ms
Execution Time: 14.369 ms
```

**This is the query that did NOT meaningfully improve, and it's worth being honest about why.** 16.091ms → 14.369ms is only ~11% faster — nowhere near the bounded case's 2.9x. There's no range to push into the index condition when every row matches (`clicked_at >= '1970-01-01'`), so the only benefit left is `Index Only Scan` avoiding the heap (`Heap Fetches: 0`, vs. a `Bitmap Heap Scan` with real heap reads before) — real, but small next to the dominant cost, which is unavoidable in both versions: sorting all 45,762 matching rows for the `GROUP BY` (`Sort Method: quicksort Memory: 1537kB`, ~12.6ms of the ~14.4ms total). **The composite index's second column earns its keep specifically on bounded queries** — this is direct evidence for the product decision (§2 of the plan) to bound `GET /api/links/:id/stats` with a default `?days=30`/max 365 rather than leaving it unbounded: the unbounded case is also the one the index helps least.

---

## Drop-and-replace proof queries

Required before removing `links_user_id_index` and `clicks_link_id_index`: confirm every query shape those single-column indexes served is still served by the new composites, not just the two target queries this migration was built for.

**Bare filter, `links.user_id`, no `ORDER BY`:**
```
Bitmap Heap Scan on links  (cost=40.55..970.74 rows=1050 width=105) (actual time=0.066..0.220 rows=1058 loops=1)
  Recheck Cond: (user_id = '9011ba9f-9fd9-426e-8416-c30e0d6f3c8d'::uuid)
  ->  Bitmap Index Scan on links_user_id_created_at_id_index (...) rows=1082 loops=1
Execution Time: 0.275 ms
```
Still uses the composite (leftmost column). No fallback to a table scan.

**Bare filter, `clicks.link_id`:**
```
Bitmap Heap Scan on clicks  (cost=1284.22..12498.55 rows=46426 width=131) (actual time=1.816..6.282 rows=45762 loops=1)
  Recheck Cond: (link_id = '8bbc8cc3-274c-4cc2-a446-2956dfbd7358'::uuid)
  ->  Bitmap Index Scan on clicks_link_id_clicked_at_index (...) rows=45762 loops=1
Execution Time: 7.676 ms
```
Same — the composite serves this fine.

**FK cascade delete — the highest-stakes check.** `DELETE FROM users WHERE id = $1` for the busiest seeded user (1,058 owned links), wrapped in `BEGIN; ...; ROLLBACK;`:
```
Delete on users  (cost=0.27..8.29 rows=0 width=0) (actual time=0.088..0.088 rows=0 loops=1)
  ->  Index Scan using users_pkey on users (...)
Trigger for constraint links_user_id_fkey on users: time=0.618 calls=1
Trigger for constraint clicks_link_id_fkey on links: time=21.288 calls=1058
Execution Time: 22.088 ms
```
The `links` cascade fires once (statement-level, 0.618ms for all 1,058 rows) and the `clicks` cascade fires once per deleted link (row-level, 1,058 calls, 21.288ms total — ~0.02ms/call). To confirm what each of those 1,058 per-link `DELETE FROM clicks WHERE link_id = $1` calls actually does, the same statement was run directly and rolled back:
```
Delete on clicks  (cost=1284.22..12498.55 rows=0 width=0) (actual time=28.160..28.161 rows=0 loops=1)
  ->  Bitmap Heap Scan on clicks
        ->  Bitmap Index Scan on clicks_link_id_clicked_at_index (...) rows=45762 loops=1
Execution Time: 28.222 ms
```
**Confirmed: the FK cascade's per-link clicks delete uses `clicks_link_id_clicked_at_index`, not a `Seq Scan`.** Dropping `clicks_link_id_index` did not turn user deletion into a table scan — the exact regression this check exists to rule out.

---

## Write-path benchmark — after

Same `processClickJob` benchmark, same link mix, same N=1,000, run after the migration:

```json
{"n":1000,"p50Ms":0.654,"p95Ms":0.836,"meanMs":0.693,"maxMs":2.971}
```

vs. before:
```json
{"n":1000,"p50Ms":0.647,"p95Ms":0.896,"meanMs":0.719,"maxMs":9.974}
```

**Honest result: no measurable regression.** p50 is 0.007ms higher (within noise), p95 and mean are both slightly *lower*, and the max dropped substantially (9.974ms → 2.971ms, almost certainly an outlier — e.g. a connection-warmup or checkpoint stall in the "before" run — not a systematic effect). The expectation going in was that the new `clicks(link_id, clicked_at)` index would add a small but real per-insert write cost. At this table size (494k+ rows) and this benchmark's scale (1,000 transactions), that cost is real but too small to distinguish from ordinary run-to-run variance. **The honest conclusion is "no observed write-cost regression at this scale," not "indexes are free"** — a much larger table, or a benchmark with more repetitions to average out noise, would be needed to actually measure the marginal per-insert cost of one more B-tree maintenance operation, which is real in principle even where it isn't visible here.

---

## Summary table

| Query | Before | After | Delta | Index |
|---|---|---|---|---|
| Redirect lookup | 0.135 ms (Index Scan) | 0.062 ms (Index Scan, unchanged) | ~unchanged | — (not a target) |
| Link list rows | 0.391 ms (Sort + Bitmap Heap Scan) | 0.072 ms (Index Scan, no Sort) | **~5.4x faster** | `links_user_id_created_at_id_index` |
| Link list count | 0.135 ms (Index Only Scan) | 0.129 ms (Index Only Scan) | ~unchanged | same (incidental) |
| Cleanup sweep | 24.478 ms (Seq Scan, 50,000 rows) | 14.123 ms (Bitmap Index Scan, 1,441 rows) | **~1.7x faster** | `links_expires_at_active_partial_index` |
| Click aggregation (30d) | 8.457 ms (Filter after fetch + Sort) | 2.868 ms (Index Cond + Sort, no wasted fetch) | **~2.9x faster** | `clicks_link_id_clicked_at_index` |
| Click aggregation (unbounded) | 16.091 ms | 14.369 ms | **only ~11% faster — see note above** | same, weaker benefit |
| Write path (p50 / mean, n=1000) | 0.647 / 0.719 ms | 0.654 / 0.693 ms | no measurable regression at this scale | (write-cost check, not a read target) |

**Did not meaningfully improve:** the unbounded click-aggregation query (5b) and the count-only list query (3) — both explained above, neither is a defect in the indexing choices, both are explained by what the query actually needs to do.
