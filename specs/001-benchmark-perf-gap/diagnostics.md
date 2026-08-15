# Phase 0 Diagnostics — Results

**Feature**: [[spec.md]] | **Plan**: [[plan.md]] | **Research**: [[research.md]] | **Date**: 2026-08-13

**Scope of this run**: diagnostics only, per explicit approval — no fixes, no schema/architecture
changes, no commits. Two source files were temporarily instrumented, exercised locally, and reverted
(`git checkout --`) before this report was written; the working tree is back to its pre-diagnostic
state (verified with `git status`/`git diff --stat`).

## Methodology and an explicit scope caveat

All numbers in this file come from **`scripts/load-test.ts` run locally against the exact
`docker-compose.yml` resource limits** (app 0.5 CPU/256 MB, PostgreSQL 1 CPU/1 GB), at increasing
`WORKERS` concurrency (6 → 16 → 32 → 64 → 128), plus direct `EXPLAIN (ANALYZE, BUFFERS)` and
`pg_stat_*` introspection against the running PostgreSQL container.

**We do not have access to the official load generator's source, batch size, concurrency model, or
network path** (`https://loadgen.foothilltech.net/` is a black box to us beyond its published report).
Every finding below is labeled by exactly what it establishes:

- **Confirmed directly from the official report** (no local reproduction needed — read straight off
  the numbers already in hand).
- **Confirmed locally** — reproduced against the real, resource-limited stack, with concrete measured
  numbers. This establishes the *mechanism is real and active in this codebase*, and, where the local
  magnitude lines up with the official numbers, that the mechanism is a *plausible sufficient
  explanation* for what the official run saw. It does **not** by itself prove the official generator
  triggers it the same way (different concurrency model, network latency, batch size, or something
  else entirely could also be at play) — that would require either the official generator's
  methodology or another official re-submission with a targeted change.

This distinction matters most for the pool-queuing finding below, and is applied consistently
throughout.

## Run summary

| Run | Workers | Batch size | Rows sent | Confirmed-directly logs/sec | Ingestion p50/p95/p99/max | Aggregate p50/p95 | Failed requests |
|---|---:|---:|---:|---:|---|---|---:|
| 1 | 6 | 2,500 | 150,000 | 18,490 | 409 / 913 / 1,092 / 1,092 ms | 161 / 370 ms | 0 |
| 2 | 16 | 1,000 | 150,000 | 12,895 | 703 / 1,017 / 1,099 / 1,124 ms | 525 / 1,292 ms | 0 |
| 3 | 32 | 500 | 200,000 | 16,554 | 594 / 836 / 897 / 998 ms | 779 / 1,194 ms | 0 |
| 4 | 64 | 300 | 300,000 | 15,682 | 924 / 1,380 / 1,572 / 2,269 ms | 1,601 / 2,016 ms | 0 |
| 5 | 128 | 200 | 300,000 | 13,279 | 1,479 / 2,285 / 3,564 / 4,739 ms | 2,110 / 2,476 ms | 0 |
| 6 | 64 (concurrent w/ EXPLAIN probes, table already at 1.1M rows) | 300 | 300,000 | 16,877 | 1,011 / 1,489 / 1,701 / 1,792 ms | 1,586 / **4,221** ms | 0 |

Final row count after all runs: **1,400,000** — the ~1,000,000-row target was reached and exceeded
locally without errors or missing data (relevant to spec.md FR-010, previously "unverified").

Table is read left-to-right: as realized concurrency rises well past the pool's 7-connection budget,
both ingestion and aggregation latency degrade sharply, throughput does **not** increase past ~15–18K
logs/sec regardless of offered concurrency (it is not concurrency-starved, it is ceiling-bound), and
**Run 6's aggregate p95 (4,221 ms) lands inside the official report's 4,600–5,990 ms range** — the
closest local reproduction gets to the official magnitude in this diagnostic pass.

No run produced an actual HTTP error or timed-out request locally (0 failed requests throughout,
even at 128 workers with ingestion max latency of 4.7 s) — this is a real, noted gap between the local
reproduction and the official report's 15–22% HTTP error rate, discussed under Root Cause #2 below.

## A1 — Pool-wait telemetry findings

Temporary instrumentation measured (a) per-request time to acquire a pooled connection before
`insertLogs`'s COPY could start, and (b) a 500 ms periodic sample of `pool.totalCount` /
`pool.idleCount` / `pool.waitingCount`.

| Run | Workers | Acquire p50 / p95 / max | Max `waitingCount` observed | Samples with `waitingCount > 0` |
|---|---:|---|---:|---|
| 1 | 6 | 0.13 / 405 / 604 ms | 0 | 0 / 112 |
| 2 | 16 | 199 / 465 / 695 ms | 10 | 11 / 186 |
| 3 | 32 | 319 / 569 / 703 ms | 25 | 25 / 309 |
| 4 | 64 | 692 / 995 / 1,280 ms | 58 | 54 / 407 |
| 5 | 128 | 969 / 1,910 / 2,186 ms | 122 | (not separately sampled at this step) |

**Confirmed locally**: `pool.totalCount` pins at exactly 7 (the configured `max`) under any load
above ~6 concurrent requests, and `waitingCount` grows monotonically with offered concurrency,
reaching 122 queued acquire calls at 128 workers. Per-request acquire wait time grows in lockstep,
from effectively 0 ms at low concurrency to a p95 of 1.9 s at 128 workers. This directly confirms the
mechanism behind Root Cause #2 in [[research.md]]: **the 7-connection pool is a real, currently-active
queuing point**, not just a plausible story fit to the latency numbers.

**Not (yet) confirmed**: none of our local runs pushed acquire wait past the 5,000 ms
`connectionTimeoutMillis` far enough to trigger the app's 503-shedding path (max observed acquire
wait was 2.19 s at 128 workers) — locally we reproduced the *slowdown* signature but not the
*error-rate* signature (15.14–22.10% in the official report). Either the official generator sustains
materially higher concurrency than 128, or real network latency (vs. our localhost loop) adds enough
additional delay on top of the measured acquire time to cross the timeout threshold, or both. This
gap is explicitly unresolved and should not be read as "the pool isn't the cause of the error rate" —
only as "we have not locally reproduced the error rate specifically, only the latency degradation
that precedes it."

## A2 — EXPLAIN ANALYZE / statistics findings

### The aggregation query is not the problem in isolation

`EXPLAIN (ANALYZE, BUFFERS)` on the primary (ungrouped, 1-hour-bucket) aggregation query, run
quiescent (no concurrent load) against 1,099,951 matching rows:

- Plan: `Index Only Scan` on `idx_logs_level_timestamp_id` → `HashAggregate` → `Sort`.
- **0 heap fetches** — a pure index-only scan, entirely served from `shared_buffers` (all 116,079
  buffer accesses were cache hits, no disk I/O).
- **Execution time: 343 ms.** Well inside the 1 s p95 target, on a dataset already past the
  ~1,000,000-row scale target.

**This rules out "the aggregation query has a bad plan or is missing an index" as an explanation** —
in isolation, on real data at target scale, it is fast and efficiently planned.

### The same query, run twice more while 64-worker concurrent ingestion was active

| Probe | Rows scanned | Heap Fetches | Buffers hit | Execution time |
|---|---:|---:|---:|---:|
| Quiescent (baseline) | 1,099,951 | 0 | 116,079 | 343 ms |
| +3 s into concurrent load | 1,143,736 | 57,519 | 243,800 | 1,781 ms |
| +6 s into concurrent load | 1,237,634 | 130,410 | 483,289 | 4,122 ms |

**Confirmed locally, and this is a new, specific finding beyond what [[research.md]] had** — this was
not previously identified in this fidelity: the query's execution time under concurrent insert load
grows far faster than the ~13% growth in row count over the same window (1.10M → 1.24M rows) can
explain. The specific mechanism, visible directly in the plan, is that **`Heap Fetches` goes from 0 to
130,410** — the `Index Only Scan` optimization (which lets PostgreSQL answer purely from the index
without touching the table heap) increasingly falls back to real heap reads. This happens because
newly-inserted pages are not yet marked all-visible in PostgreSQL's visibility map until a vacuum
revisits them — and under sustained high-volume concurrent inserts, there is a constantly-growing
"recently written, not yet vacuumed" tail of the table, which is exactly the part of the table a
`since=<recent>, until=now` aggregation query (the shape the contract and the benchmark both use)
concentrates on. `pg_stat_user_tables` confirms autovacuum is running (5 autovacuum runs observed
during the diagnostic session, consistent with the already-applied `0001_tune_logs_autovacuum.sql`
migration's aggressive insert-triggered settings) and `n_dead_tup = 0` (no bloat from updates/deletes,
as expected for an insert-only table) — so this is not a vacuum-is-broken problem, it is a
structural consequence of how fast pages are being produced relative to how fast they can be marked
visible, under sustained write load, interacting with the query's reliance on an index-only scan.

This gives a second, independently confirmed contributor to aggregate latency under load, additive to
the pool-queuing contributor (A1): of the ~4.1 s total execution time in the "+6 s" probe, acquire-wait
telemetry from the same period (Run 4/5 data) suggests roughly half is connection queuing and roughly
half is this heap-fetch-driven query slowdown — both real, both currently active, neither one alone
fully explaining the total.

### Index usage sanity check

```
indexrelname                    idx_scan   idx_tup_read   size
logs_timestamp_id_pk             118        3,413,771     51 MB
idx_logs_service_timestamp_id      0                0     80 MB
idx_logs_level_timestamp_id       47       34,241,807     72 MB
```

`idx_logs_service_timestamp_id` saw zero scans in this diagnostic session because none of our probe
queries filtered by `service` — this is a property of the diagnostic queries run, not a finding about
the index's general usefulness, and is called out here only so it isn't mistaken for one.

## Updated status of research.md's root causes

| # | Root cause | Prior label | Updated label |
|---|---|---|---|
| #1 | App idle / PostgreSQL saturated | CONFIRMED | Unchanged — CONFIRMED (from the official report directly) |
| #2 | Pool ceiling (`max: 7`, 5 s timeout) causes queuing | HIGH-CONFIDENCE HYPOTHESIS | **Mechanism CONFIRMED LOCALLY** (real, measured, scales with concurrency exactly as predicted); **official-report error-rate magnitude still HYPOTHESIS** (not locally reproduced — see A1 gap above) |
| #3 | PostgreSQL CPU attribution unclear | CONFIRMED (saturation) / HYPOTHESIS (attribution) | **Attribution now partially CONFIRMED**: a specific, measured mechanism (index-only-scan → heap-fetch fallback under concurrent inserts) is identified and quantified; this is additive to, not a replacement for, pool queuing (#2) and general write-path cost (COPY + 3-index maintenance), which remain not fully decomposed from each other |
| #4 | Official generator's concurrency/pacing differs from the local harness | HYPOTHESIS | **Still HYPOTHESIS**, but now a *better-informed* one: pushing local concurrency far past the original 6-worker harness (up to 128 workers) reproduces aggregate latency within the official range (4.22 s local vs. 4.60–5.99 s official) but does not yet reproduce the official error rate — consistent with the official generator running at even higher concurrency, or over a network path with added latency, or both. Not confirmed which. |
| #5 | App-side resource exhaustion ruled out | RULED OUT | Unchanged |
| #6 | ~1M-row scale behavior unverified | UNVERIFIED | **Substantially addressed locally**: 1,400,000 rows ingested and queried successfully with 0 errors/missing rows during this session — the codebase itself does not show a hard failure mode at this scale. The official benchmark's own per-scenario row counts (175K/98K/161K) still don't show 1M reached *within a single named scenario*, which may simply reflect scenario duration rather than a system limitation — this is a difference between "does the system break at 1M rows" (no evidence it does) and "did any one official scenario individually reach 1M rows" (no evidence it did either way from the given summary). |

## Bottleneck identification (direct answer to "what is the exact bottleneck")

Two concurrent, additive, locally-confirmed bottlenecks, both traceable to the same root pressure —
**PostgreSQL's single CPU core becoming the binding constraint under concurrent write + read load,
funneled through a connection pool sized well below the concurrency the official generator appears to
offer**:

1. **Connection pool queuing** (`src/db/index.ts`: `max: 7`, `connectionTimeoutMillis: 5000`).
   Confirmed active and scaling with concurrency; not yet confirmed to be the specific mechanism
   producing the official report's HTTP error rate (only its latency precursor was reproduced).
2. **Index-only-scan → heap-fetch fallback on the aggregation query under concurrent insert load**,
   caused by pages not yet being marked all-visible while ingestion is running hot. Confirmed and
   quantified locally; roughly comparable in magnitude to (1) in the one concurrent probe we ran.

Both point at the same underlying resource (PostgreSQL's single CPU core, shared by COPY ingestion,
three-index maintenance, and aggregation scanning) rather than at any correctness defect, missing
index, or bad query plan — consistent with the official report's own "PostgreSQL CPU 70–107%,
application CPU 5–20%" split.

## Recommended changes (not implemented — for approval)

These are refinements to [[plan.md]]'s Phase B, informed by what Phase 0 actually found. Still no
code has changed.

1. **B1 (pool sizing), refined**: the case for *some* pool change is now measured, not just inferred
   from official numbers — but the safe ceiling is still bounded by PostgreSQL's single CPU core, and
   diagnostics 2/3 above show that raw concurrency alone doesn't buy throughput (Run 5 at 128 workers
   ingested *slower* than Run 1 at 6 workers: 13,279 vs. 18,490 logs/sec) — so a blind `max` increase
   without also addressing (2) risks trading latency for even worse CPU contention. **Recommended
   framing**: pair any pool change with a small, targeted local A/B (same harness, same row count,
   pool `max` at a couple of candidate values) before proposing a specific number — expected impact
   is real but the right number is not yet known. Risk: low (fully reversible config value); moderate
   if sized without the A/B step.
2. **New: investigate whether more frequent/aggressive autovacuum (or a manual `VACUUM`/visibility-map
   warm-up cadence) measurably reduces the heap-fetch fallback under load**, given `0001_tune_logs_
   autovacuum.sql` is already tuned toward this but the fallback still occurs at the concurrency levels
   tested. This is additive investigation, not yet a proposed schema/config change — it needs its own
   small before/after measurement (repeat the Run 6 EXPLAIN probe with a candidate setting) before
   being promoted to a Phase B item. Risk: low to try, unknown impact until measured.
3. **B3 (harness upgrade), now partially done**: this diagnostic session's higher-`WORKERS` runs
   already function as a first version of the "reproduce official-like concurrency" harness described
   in [[plan.md]]. Formalizing this (a permanent script/flag rather than one-off env vars) is now
   lower-risk and lower-effort than originally scoped, since the shape has already been validated to
   move the local numbers into the official report's range.
4. **B2 (index/query tuning)**: still **not recommended** as a standalone change. A2 confirmed the
   query's own plan is efficient in isolation — the cost under load is a concurrency/visibility
   interaction, not a query-shape defect. Restructuring the query or indexes without addressing (1)/(2)
   first would not be expected to help, per the evidence gathered here.

## Phase B — implemented changes (2026-08-13, later same day)

Approved scope: #1 (pool-size A/B) and #2 (heap-fetch/autovacuum) together, then reassess. All
changes below were tested against `official-benchmark-results.md` (the confirmed, full 4-stage
report) as the standing reference. Nothing has been committed — working tree only, pending review.

### B1 — Pool split + right-sized timeout (implemented)

**What changed**: `src/db/index.ts` now creates two separate `pg.Pool` instances instead of one —
`ingestPool` (used only by `insertLogs`'s COPY) and `queryPool` (used by `findLogs`, `aggregateLogs`,
retention, health, and migrations, wrapped by `db`). This directly targets the "Queries" category
scoring only 6/15 in the official report: a burst of ingestion COPY calls can no longer hold every
available connection and starve the required 1 req/sec aggregation traffic behind it. Both pools and
`connectionTimeoutMillis` are now configurable via `DB_INGEST_POOL_MAX`, `DB_QUERY_POOL_MAX`,
`DB_POOL_CONNECT_TIMEOUT_MS` (new, optional, defaulted — zero-config `docker compose up` behavior is
unchanged).

**A/B methodology**: candidates were tested at `WORKERS=64` and `128` against the resource-limited
stack, first at a single batch size (300), then — critically — re-checked across a **range** of batch
sizes once a robustness problem surfaced (see below). Four candidates were tried:

| Candidate | ingest max | query max | timeout | W64: logs/sec, failed, agg p95 | W128: logs/sec, failed, agg p95 |
|---|---:|---:|---:|---|---|
| Original (pre-change) | 7 (shared) | — | 5000ms | 15,682/s, 0 failed, 2,016ms | 13,279/s, 0 failed, 2,476ms |
| A | 12 | 6 | 1000ms | 18,382/s, 19 failed, 658ms | 16,703/s, 332 failed, 903ms |
| B | 20 | 8 | 800ms | 21,432/s, 0 failed, 677ms | 14,498/s, 420 failed, 966ms |
| C | 16 | 10 | 1200ms | 17,642/s, 0 failed, 913ms | 13,542/s, 323 failed, 929ms |
| D | 16 | 8 | 1000ms | 18,750/s, 0 failed, 689ms | 14,199/s, 355 failed, — |

Candidate B looked best on this single-batch-size test — until a robustness check caught a serious
problem it would have shipped with.

**Important finding during the A/B (worth its own callout)**: testing candidate B at a *different*
batch size (`BATCH_SIZE=1000` instead of 300, same `WORKERS=64`) produced near-total collapse:
**690 logs/sec, 984/1000 requests failed with 503**. Root cause: an 800ms timeout is fine when each
COPY finishes well within that window (true at batch=300), but once COPY duration approaches the
timeout itself (larger batches), *every* queued request times out in the same window instead of a
graceful few, and the pool never recovers because the connections it's waiting on are themselves still
mid-COPY. This is a genuine, previously-unknown fragility that a single-batch-size A/B would have
missed and shipped. Since the official generator's batch size is unknown to us, **robustness across
batch sizes was made a hard requirement**, not just peak throughput at one shape.

**Final chosen defaults**: `DB_INGEST_POOL_MAX=12`, `DB_QUERY_POOL_MAX=8`,
`DB_POOL_CONNECT_TIMEOUT_MS=1500` — chosen because it was the only configuration tested that stayed
failure-free or low-failure across batch sizes 300/1000/2500 at `WORKERS=64`, and degraded gracefully
(no collapse) at `WORKERS=128`:

| Batch size | Workers | logs/sec | Failed | Ingestion p95 | Aggregate p95 |
|---:|---:|---:|---:|---:|---:|
| 300 | 64 | 19,998 | 0 | 1,124ms | 485ms |
| 1,000 | 64 | 17,918 | 64 | 3,279ms | 1,063ms |
| 2,500 | 64 | 20,561 | 43 | 5,530ms | 3,171ms |
| 1,000 | 128 | 14,981 | 171 | — | 1,935ms |

**Honest remaining gap**: at large batch sizes under very high concurrency, aggregate p95 still
exceeds the 1s target (up to 3.2s at batch=2,500/workers=64) and some requests are shed. This is not
a pool-sizing problem anymore — Postgres CPU contention itself (Root Cause #3, heap-fetch fallback +
general write-path cost) is now the visible ceiling once connection queuing is no longer the dominant
factor. See B2 below for why this wasn't chased further this round.

### B2 — Further autovacuum tuning (tested, NOT shipped)

**What was tried**: a new migration (`0002_tune_logs_autovacuum_v2.sql`) tightening
`autovacuum_vacuum_insert_scale_factor` (0.01→0.002) and `autovacuum_vacuum_insert_threshold`
(1000→200), hypothesizing that more frequent, smaller vacuum passes would keep the visibility map
fresher and reduce the heap-fetch fallback measured in Phase 0.

**What was measured**: results were noisy and did not show a clear, reproducible improvement.
Two-point `EXPLAIN ANALYZE` probes (matching Phase 0's methodology) showed lower heap-fetch counts
with the new settings in one comparison (80K/84K vs. 496K/667K) but the *execution times* told the
opposite story in places (2.6s/6.2s new vs. 6.2s/3.0s old — non-monotonic, inconsistent with heap
fetches alone explaining the cost). A larger, many-sample comparison (full load-test runs rather than
two-point probes) was planned but the first full run under the new settings hit the B1 batch-size
fragility described above before a clean comparison could complete. The working theory for the
noise: more frequent autovacuum runs (cost_delay is already 0, i.e. unthrottled) now compete more
often for the same single CPU core against concurrent COPY and query traffic — trading "heap-fetch
cost" for "vacuum-process CPU contention," a wash or possibly net-negative rather than a clear win.

**Decision**: per Constitution Principle VII (no change ships without a measured, reproducible
benefit) and the plan's own gating for B2 ("if A2 does not surface a clear, attributable cost, B2 is
not implemented"), this migration was **removed**, not shipped. The table's autovacuum settings
remain exactly as migration `0001_tune_logs_autovacuum.sql` left them
(`scale_factor=0.01`, `threshold=1000`, `cost_delay=0`). This is a legitimate, evidence-driven
"tried it, it didn't clearly help, don't ship it" outcome — not a failure to investigate.

### B3 — Higher-concurrency harness (informally validated, not yet formalized as a script)

The `WORKERS`/`BATCH_SIZE` sweep used throughout this session (6/16/64/128 workers × 300/1,000/2,500
batch sizes) already functions as the "reproduce official-like concurrency" harness `plan.md`
described, using `scripts/load-test.ts`'s existing env-var knobs — no code changes were needed to get
this level of value. Formalizing it as a permanent script/CI job is still open and lower priority now
that it's done its job of catching the B1 batch-size fragility.

### Final validation (all Phase B changes together, against the confirmed official reference)

- `npm run typecheck && npm run build`: clean.
- `docker compose --profile test run --rm test` (42 tests, real Postgres, matches CI): **42/42 pass**,
  no assertions changed or weakened.
- `docker compose up --build -d` from a clean `down -v`, zero configuration: healthy in ~8s, migrations
  `0000` and `0001` applied automatically (the reverted `0002` is gone from the journal — confirmed via
  `drizzle.__drizzle_migrations` and `pg_class.reloptions`).
- `scripts/audit-run.sh`: **30/30 PASS**, unmodified.
- Load matrix (`BATCH_SIZE=1000`, final config) vs. the pre-Phase-B baseline and the official report:

| Workers | logs/sec (local, after) | logs/sec (local, before Phase 0 baseline) | Aggregate p95 (local, after) | Official achieved (any stage) |
|---:|---:|---:|---:|---:|
| 6 | 27,277 | 18,490 | 357ms | 584–2,549/s, 4.08x–5.99x over 1s target |
| 16 | 30,005 | 12,895 | 944ms | (same range) |
| 64 | 22,609 (43 failed) | 15,682 | 1,368ms | (same range) |
| 128 | 18,365 (117 failed) | 13,279 | 1,672ms | (same range) |

Every tested concurrency level now exceeds the 15,000 logs/sec baseline target locally, and aggregate
p95 is dramatically closer to (and at low/medium concurrency, under) the 1s target — a large,
consistent local improvement over both the pre-Phase-B baseline and the official numbers on hand. The
standing methodology caveat still applies in full: this is evidence the mechanisms fixed were real
and the fixes work, not proof of the exact official score movement, which requires an official
re-submission to confirm (not run in this session, per your review-before-commit instruction).

## Bounded round 2 — diagnosing and (not) fixing the remaining aggregate p95 gap (2026-08-13, later still)

Scope: diagnose the batch=2500/high-concurrency aggregate p95 gap properly (no guessing), try up to
two fixes with the same A/B rigor as B1, hard stop after two if neither reproducibly improves things.
Both attempts were tried; neither improved anything; both were reverted. Documented here in full so
the two attempts aren't wasted even though nothing shipped from them.

### Diagnosis: precise profiling of the batch=2500/workers=64 scenario

Prior root-cause attribution (Phase 0/B2) assumed PostgreSQL CPU contention was the whole story. That
was true at the throughput the *official* report achieved (600–2,500 logs/sec), but B1 pushed local
throughput to 20,000+ logs/sec — high enough to surface a **different** bottleneck at this specific
batch size:

- **cgroup-measured CPU** (`/sys/fs/cgroup/cpu.stat` deltas, precise, not `docker stats` sampling
  artifacts) during a live batch=2500/workers=64 run: **application container at 72.1% of its 0.5 CPU
  budget**, **PostgreSQL at only 22.0% of its 1 CPU budget** — a reversal of the picture from smaller
  batches / the official benchmark's achieved rates, where Postgres was the saturated one.
- **`pg_stat_activity` sampling** (300ms interval) during the same scenario: 70/97 (72%) of sampled
  COPY-holding Postgres backends were in `wait_event_type=Client, wait_event=ClientRead` — genuinely
  blocked waiting for the *application* to send more COPY data, not doing Postgres-side work. Only a
  small minority showed real Postgres-side contention (`LWLock`/`BufferContent`/`WALInsert`, 7/97).
- **A real Node.js CPU profile** (`--cpu-prof` via `NODE_OPTIONS`, captured mid-run, analyzed by
  self-time per function): after excluding one-time module-loading startup noise, the identifiable
  application hot-path functions (`parseIsoTimestamp`, `validateLogEntry`, `toCopyTextRow`,
  `copyTextField`, GC) together account for roughly 5–8% of a core — real, but not close to explaining
  a sustained 72%-of-budget application CPU load on their own. The remaining cost is not attributable
  to any single hot JS function; the evidence (many concurrent COPY streams, `ClientRead`-dominated
  wait states, cgroup-vs-profiler discrepancy) points at Node/libuv/stream-management overhead from
  orchestrating many concurrent COPY streams on one thread, which a JS-level CPU profile does not
  cleanly attribute to a single call site.

**Conclusion of diagnosis**: at this specific shape (large batches, high concurrency), the
**application**, not PostgreSQL, is the primary constraint — a materially different and non-obvious
finding versus the rest of this document, confirmed by three independent measurement methods
(cgroup accounting, wait-event sampling, CPU profiling), not inferred from one signal alone.

### Attempt 1 — single upfront write instead of chunked streaming (implemented, measured, reverted)

**Hypothesis**: `insertLogs` streams COPY data via a generator yielding 500-row chunks through
`Readable.from()` + `pipeline()`; since building an entire batch synchronously was measured to take
only single-digit-to-low-double-digit milliseconds, replacing the multi-chunk stream with one
upfront-built string + a single write should reduce Node stream-machinery overhead per request.

**What shipped for testing**: `insertLogs` built the whole COPY payload before acquiring a connection
and wrote it as one `Readable.from([buffer])` chunk. Also bundled: a single-pass attribute JSON
serializer (`buildAttributeJson`) replacing two separate `JSON.stringify` calls + an intermediate
object, and a `.test()`-before-`.replace()` fast path in `copyTextField`.

**A real bug this caught**: the first version of the fast-path skipped `copyTextField` entirely for
the two JSON-encoded fields, reasoning that JSON.stringify's escaping made them already COPY-safe.
That reasoning was **wrong** — JSON's escaping *produces* literal backslash characters (e.g. `\"`,
`\\`, or the two-character sequence `\t`), which is exactly what COPY text format itself needs
re-escaped. `tests/api.integration.test.ts`'s special-character round-trip test caught this
immediately as a 500 error. Fixed by keeping `copyTextField` applied to all six fields. A second bug
(dropping the `/g` flag when factoring the regex into a constant, so `.replace()` only fixed the
*first* special character in a field) was caught by the same test. Both fixed before any performance
measurement was trusted.

**Rigorous A/B result** (controlled: fresh `down -v` + rebuild + reseed before each run, not reused
containers): at batch=2,500/workers=64, single upfront write gave **21,394 logs/sec, agg p95 2,086ms**
versus the pre-attempt baseline's **28,495 logs/sec, agg p95 1,400ms** — worse on both axes.

**Why (best explanation)**: building one large (~600KB–1MB) string synchronously before any I/O
starts concentrates CPU-bound work into one long, uninterruptible block per request. With 64 requests
doing this concurrently on a single-threaded, 0.5-CPU-limited event loop, this hurts fairness — other
concurrent requests (including aggregate queries) wait longer for their turn. The original chunked
generator, by contrast, naturally interleaves each 500-row build with the stream's own backpressure
waits, giving the event loop many small opportunities to service other requests instead of one big one.
**Reverted in full** — back to the chunked-generator structure.

### Attempt 2 — keep chunking, add only the CPU micro-optimizations (implemented, measured, reverted)

**Hypothesis**: Attempt 1's regression was specifically caused by the streaming-to-single-write
restructuring, not by the JSON-serialization/escaping micro-optimizations. Re-apply only
`buildAttributeJson` and the escape fast-path *within* the original chunked-generator structure,
leaving the chunk-per-500-rows I/O timing untouched.

**A real lesson on noise**: a single run at batch=2,500/workers=64 initially looked worse than
baseline (agg p95 2,415ms), but a repeat of the *identical* code and scenario produced 1,586ms — a
53% swing between runs of the same code. This forced a proper multi-run comparison rather than
trusting single data points, exactly the trap the earlier B1 round warned about. **3 runs each**,
same controlled methodology:

| Variant | Run 1 | Run 2 | Run 3 | Throughput range |
|---|---:|---:|---:|---|
| B1-only baseline (agg p95) | 1,400ms | 1,392ms | 2,003ms | 27,263–28,495 logs/sec |
| Attempt 2 (agg p95) | 2,415ms | 1,586ms | 2,888ms | 21,394–25,939 logs/sec |

The **throughput ranges do not overlap** (baseline's minimum, 27,263, exceeds Attempt 2's maximum,
25,939, in every one of 3 runs each) — a reproducible regression, not noise, even though the p95
numbers individually are noisy. Median aggregate p95 is also worse (2,415ms vs. 1,400ms).

**Why (best explanation, held with lower confidence than Attempt 1's)**: V8's native `JSON.stringify`
is highly optimized C++ that a hand-written JS string-concatenation loop doing equivalent work is not
guaranteed to beat, even when it does less nominal work (fewer tree-walks, no intermediate object) —
a plausible case of a manual "optimization" losing to a JIT-friendly built-in. Not fully proven; noted
as the working theory, not fact. **Reverted in full** — back to the original, unmodified hot path.

### Outcome: hard cap reached, gap remains, documented as a known limitation

Both attempts were implemented, measured with the same rigor as B1 (multi-batch-size and, once noise
appeared, multi-run), and both reverted after failing to reproduce an improvement — the second one
only after a real, human-relatable lesson about not trusting a single run. Per the two-attempt cap,
no further fix attempts were made this round. The codebase is back to exactly its B1-only state
(`git diff --stat src/repositories/logs.repository.ts` shows only the B1 pool-rename, confirmed after
this round). This is written up as a known limitation in the README (see below), not silently dropped.

## Round 3 — diagnosing the "Queries" score gap (6.00/15.00 official, Correctness 15.00/15.00) (2026-08-13, later still)

Scope: the report itself gave no per-check breakdown (`loadgen.foothilltech.net/submission/...` is a
client-rendered SPA — `WebFetch` only sees the app shell, no data; confirmed inaccessible, not
guessed). Per your fallback instruction, systematically tested `GET /logs` and `GET /logs/aggregate`
under concurrent ingestion load, not just quiescent.

### Finding 1 — CONFIRMED BUG, FIXED: query-path pool exhaustion was returning 500, not 503

**Diagnosis**: fired a stream of concurrent `GET /logs`/`GET /logs/aggregate` requests (20 workers)
against the same heavy-concurrent-ingestion condition already known to exhaust the connection pool (40
ingestion workers). Result: 9/267 query requests (3.4%) returned a raw `500`, while `POST /logs` under
the identical condition correctly returned `503` every time. Root-caused by direct instrumentation
(not guessed): `src/server/app.ts`'s `isPoolExhaustionError` pattern-matches `error.message` against
known pg-pool exhaustion strings — this works for the ingestion path (`insertLogs` calls the raw
`pg.Pool` directly, so the thrown error's `.message` *is* exactly `"timeout exceeded when trying to
connect"`). But `findLogs`/`aggregateLogs` go through **Drizzle**, which wraps driver errors in a
`DrizzleQueryError`. Measured directly: depending on the exact internal code path Drizzle takes for a
given query shape, the underlying pg-pool message is **sometimes folded into `DrizzleQueryError`'s own
`.message`** (classified correctly) and **sometimes left only on `.cause`** (Node's standard `Error`
cause-chaining) — in the second case, `isPoolExhaustionError` checked `.message` only, missed the
pattern, and the request fell through to a generic uncaught-error `500`.

This precisely explains a *query-specific* correctness gap distinct from `Correctness` (15/15,
ingestion-focused) and `Reliability` (20/20, data-loss-focused): a raw, undocumented `500` in response
to a query check — instead of the spec-sanctioned `503`+`Retry-After` backpressure signal context.md
explicitly calls out as correct ("shedding load with 429 or 503 plus Retry-After is better than
crashing") — is exactly the kind of thing a query-correctness check would score as a failure, and it
only ever happens on the query path, matching the score pattern (`Correctness` perfect, `Queries` weak)
better than any other hypothesis tested this round.

**Fix (Attempt 1 of this issue, succeeded — no Attempt 2 needed)**: `isPoolExhaustionError` now walks
the `.cause` chain (bounded to depth 5, guards against a pathological cycle), checking each level's
message against the same patterns. Purely internal error-classification change — no endpoint, response
shape, or validation rule touched.

**Verification**: `npm test` (42/42), `scripts/audit-run.sh` (30/30), then the identical concurrent
query-vs-ingestion scenario run **3 times** post-fix: **0/900+ query requests returned 500** in any
run; every shed request correctly returned `503` with `Retry-After`. Reproducible, not a fluke.

```
before: {"200":258,"500":9}     (3.4% raw 500s)
after:  {"200":300,"503":10}    run 1
after:  {"200":284,"503":13}    run 2
after:  {"200":289,"503":8}     run 3
```

### Finding 2 — DIAGNOSED, inherent to the required contract, not fixable without violating it: cursor-pagination sweeps miss concurrently-backfilled rows

**Diagnosis**: seeded 3,000 rows with timestamps scattered uniformly across a month (matching how our
own `load-test.ts`, and very plausibly the official generator, produce "~1 month of data"), then
started a full cursor-pagination sweep of `GET /logs` while concurrently inserting 1,500 more rows
with the same scattered-timestamp pattern. Result: **0 duplicates** (pagination's no-duplicate
guarantee held), but **553–893 of the concurrently-inserted rows (12–20%, varied by run) were never
returned** by the in-progress sweep.

**Mechanism**: the sweep walks `(timestamp, id) DESC`, moving from newest to oldest. A row inserted
*during* the sweep with a timestamp *newer* than the sweep's current cursor position belongs to a page
already fetched — the sweep never revisits it. This is not a bug in the ordering, tie-breaking, or
cursor-encoding logic (all separately verified correct, and unaffected by concurrent writes); it is a
mathematical consequence of combining **(a)** the required "sorted by timestamp descending" contract
with **(b)** cursor pagination with **(c)** client-supplied, non-monotonic (backfilled) timestamps.
Every correctly-implemented system with this exact contract has this exact property — the same
behavior any timeline/feed API with chronological sort exhibits for concurrently-published historical
content. It cannot be eliminated without either changing the required sort order (Golden Rule
violation) or constraining how ingested timestamps relate to insertion order (not ours to control —
timestamps are client-supplied).

**Decision: not attempted as a fix.** Per Constitution Principle VII and the two-attempt discipline,
attempts are for *plausible, contract-compliant* fixes — spending an attempt changing pagination
semantics would itself violate the Golden Rule constraint this round is required to preserve. Documented
here and in the README's Known Limitations instead of silently left broken or chased with a
non-compliant change.

### Finding 3 — investigated, concluded NOT a defect: apparent group_by/total sum "mismatches" under load

A quick invariant check (grouped-by-service bucket counts should sum to the ungrouped total) showed
frequent mismatches under concurrent ingestion. Traced to test methodology, not a service defect: the
two aggregate queries are two independent HTTP requests, each a separate point-in-time read against a
table receiving thousands of scattered-timestamp inserts per second between them — of course two
independently-timed snapshots of a fast-mutating dataset differ slightly. Confirmed non-issue by the
existing `groups by service`/`groups by level` tests (which already pass, quiescent, exact-match
assertions) and by Finding 2's already-established root mechanism. No fix needed; noted here so this
one isn't mistaken for a new open issue.

### Outcome

One confirmed, cleanly-fixed bug (query-path 500→503 misclassification) shipped and verified. One
inherent, contract-bound property diagnosed and documented rather than "fixed" into a contract
violation. One false alarm investigated and closed. Total: one fix attempt used (succeeded on the
first try), well under the two-attempt-per-issue cap.

## What remains unmeasured (explicit gaps, not filled in by guessing)

- The official generator's exact concurrency/batch/pacing model — still unknown. Phase B's numbers are
  the strongest local evidence we have (large, consistent gains across every tested concurrency and
  batch size), but only an official re-submission confirms the actual score/rank movement.
- At large batch sizes (2,500) under high concurrency (64+ workers), aggregate p95 still exceeds the
  1s target — root cause is now well-diagnosed (application-side CPU/event-loop contention from
  orchestrating many concurrent COPY streams, confirmed by cgroup accounting, wait-event sampling, and
  CPU profiling), but two targeted fix attempts did not reproduce an improvement. Candidates not yet
  tried: capping concurrent in-flight ingestion requests at the HTTP layer (admission control before
  JSON parsing, not just at the DB pool); moving COPY-payload construction off the main thread (e.g.
  `worker_threads`); or accepting this as a genuine capacity limit of a 0.5-CPU application container
  at very large batch sizes and documenting it rather than re-engineering ingestion further.
- Whether B2's (prior round) noisy results reflect a real (if small) autovacuum-driven CPU trade-off, or were mostly
  measurement noise from 2-point EXPLAIN probes and inconsistent starting states between trials — an
  honest open question; a properly controlled multi-trial version of that experiment was not completed
  this round.

## Round 4 — the 503-shedding cliff at 64-128 workers, and a broader Part-2 audit (2026-08-13, later still)

Trigger: a fresh local load test at full scale (`TOTAL_LOGS=1000000`, default `BATCH_SIZE=2500`)
reported 27% of logs dropped at `WORKERS=64` and 74% dropped at `WORKERS=128` — far worse than
anything the shorter (300K-row, 10-20s) A/B runs from the B1 round had surfaced. Reproduced directly:
first attempt at `WORKERS=64` actually measured **93% dropped** (372/400 requests failed), worse than
reported, confirming this is real and not a one-off.

### Part 1 — diagnosis

Same instrumentation pattern as Phase 0 (per-request pool-acquire timing + cgroup CPU deltas),
applied to the exact failing scenario:

- Of 400 total requests (1,000,000 rows ÷ 2,500/batch), only **28 ever acquired a connection**; the
  other 372 timed out waiting and were shed as 503. Acquire time for the *successful* 28 already sat at
  p50=1,207ms / p95=1,366ms — right against the 1,500ms timeout from the B1 round.
- cgroup CPU accounting during the same run: **app at 87.7% of its 0.5 CPU budget, PostgreSQL at only
  24.7% of its 1 CPU budget** — the same application-side CPU/event-loop contention mechanism
  identified in the aggregate-p95 investigation, but now at full sustained scale, not a short burst.
- Each COPY, once it had a connection, took 578-975ms to complete (`copyMs`). With pool `max: 12` and
  a completion rate far below what 64 continuously-retrying workers demand, the queue never drains —
  classic sustained-arrival-exceeds-sustained-service-rate collapse, not a brief spike.

**Root cause, precisely**: the B1 pool sizing (and its 1,500ms timeout) was validated against
300,000-row bursts lasting 10-20 seconds. That duration was long enough to look correct but too short
to reach the steady-state collapse a full, sustained 1,000,000-row run at high concurrency exposes.
This is a genuine gap in the earlier round's methodology, not a new bug — the same code, tested longer,
reveals a real problem the shorter tests couldn't.

### Part 1 — fix and A/B (full 1,000,000-row runs throughout, not shortened bursts)

Three candidates, each run to completion at `WORKERS=64` **and** `WORKERS=128` (the harder case),
plus a batch-size sweep at `WORKERS=64`:

| Candidate | ingest max | timeout | W64 dropped | W128 dropped |
|---|---:|---:|---:|---:|
| B1 baseline (before this round) | 12 | 1,500ms | 930,000 (93%) | — |
| A | 12 | 8,000ms | **0** | **0** |
| B | 6 | 5,000ms | **0** | 410,000 (41%) |
| C | 6 | 8,000ms | **0** | 142,500 (14%) |

Candidate A (`ingest max: 12` unchanged, `connectionTimeoutMillis: 1,500ms → 8,000ms`) is the only
configuration tested that reached **zero drops at both 64 and 128 workers**. Confirmed further at
`WORKERS=6/16` (zero drops, 39,920/30,072 logs/sec) and at `BATCH_SIZE=300/1,000` at `WORKERS=64`
(zero drops both, ingestion p95 as low as 992ms at batch=300). **Shipped as the new default**
(`DB_POOL_CONNECT_TIMEOUT_MS=8000`).

**Honest trade-off, not hidden**: this fixes drops by letting legitimate demand wait longer instead of
being shed — ingestion p95 at `WORKERS=128` is 12.5s and max reached 20.4s in one run. A final
zero-config confirmation run at `WORKERS=128` accepted 990,000/1,000,000 (99%) with only 4 failed
requests — a massive, reproducible improvement over the reported 74%/93% drop rates, but not a
mathematically guaranteed zero in every single run at the most extreme concurrency tested. Per your
explicit priority ("avoid dropped requests" over "aggregate p95 < 1s"), this is the correct trade-off
direction, and it's the one config that held at every concurrency/batch-size combination tried.

**Not pursued further**: a fourth candidate combining a still-larger pool with the 8,000ms timeout
was not tested — Candidate A already met the zero-drop bar at both tested extremes, and the residual
20s-tail-latency risk (a real client-side timeout on the load generator's end could still count a
technically-in-flight request as failed) is now a latency problem, already covered under the existing
"aggregate p95 exceeds target at large batch/high concurrency" known limitation, not a new open drop
problem.

### Part 2 — targeted rubric audit

**Found and fixed**: `GET /health` shares `queryPool` with `GET /logs`/`GET /logs/aggregate`. Measured
directly under the `WORKERS=128`/1M-row scenario: health-check latency reached **6,325ms** — longer
than `docker-compose.yml`'s own healthcheck `timeout: 3s`. Sustained high load could accumulate enough
timed-out healthchecks (10 consecutive needed) to flip the container to "unhealthy" from pure query
contention, not an actual outage — a real Reliability-score risk under exactly the load conditions
being fixed elsewhere in this round. **Fix**: a third, tiny, dedicated `healthPool` (`max: 2`,
`connectionTimeoutMillis: 2000ms`, deliberately short so a genuinely unreachable database is still
reported quickly) that never competes with query/ingestion traffic. **Verified**: re-ran the identical
scenario post-fix — max health-check latency dropped to 3,742ms (41% reduction), 23/24 checks
succeeded. The small residual is now bounded by PostgreSQL's own CPU saturation under the fixed 1-CPU
limit (a dedicated connection doesn't make Postgres itself faster), not connection queueing — a
smaller, different, already-understood problem, further cushioned by Docker's 10-consecutive-failure
tolerance before actually marking the container unhealthy.

**Checked, found clean**:
- SQL injection: re-swept every repository file for string-concatenated SQL — everything is Drizzle's
  tagged `sql` templates or the parameterized query builder, no exceptions found.
- Error-message leakage: the 500 path deliberately never exposes `error.message` to the client
  (`fastifyError.statusCode < 500` gate in `app.ts`) — only client errors (<500) show their message.
  Already correct, unchanged.
- Duplicate query-string parameters (e.g. `?limit=1&limit=2`, which Fastify parses as an array):
  `getQueryParameters`'s `typeof value !== "string"` check already rejects these with a clean 400,
  not a 500 or silent misparse. Already correct, unchanged.
- Pool budget: three pools now exist (`ingestPool` 12 + `queryPool` 8 + `healthPool` 2 = 22 max
  connections) — comfortably under PostgreSQL's default `max_connections` (100).

**Fixed, code quality only**: removed leftover Arabic-language and emoji-arrow comments from
`src/db/schema.ts`, `src/index.ts`, and `src/controllers/logs.controller.ts` (flagged in the original
audit, never cleaned up) — replaced with plain English explanations of the same points. Comment-only
change, verified with a full test run after.

**Not chased further, per the time-boxed instruction**: a deeper search for additional silent-failure
surfaces (e.g. retention-job interaction with the new pool split, adversarial query-string sizes) was
not performed this round — the items above were the ones a focused pass surfaced with actual
measurements behind them; anything not listed here was not specifically found, not "checked and ruled
out."

### Final validation (all of Round 4 together)

`npm run typecheck && npm run build`: clean. `docker compose --profile test run --rm test`: 42/42 pass
(run twice, once before and once after the code-quality comment cleanup). Fresh `down -v` +
`docker compose up --build -d` with zero configuration: healthy in ~8s. `scripts/audit-run.sh`: 30/30
pass. Full 1,000,000-row load test at `WORKERS=128` with zero-config defaults: 990,000-1,000,000
accepted (99-100% across repeated runs), versus 260,000-260,000 (26%) before this round's fix.

**Correction, from Round 5 below: the "99-100% across repeated runs" statement above understated
`WORKERS=128`'s true variance.** More extensive fresh-volume sampling in Round 5 found this exact
configuration ranging from 73% to 99% accepted across different runs — see Round 5 Part 3. The fix
itself (raising the timeout) remains correct and necessary; the "99-100%" figure was drawn from too
few samples to characterize the real spread at this specific, most-extreme concurrency tier.

## Round 5 — investigating a reported baseline regression, a full compliance pass, and query-latency tuning (2026-08-13, later still)

### Part 1 — the reported WORKERS=6 regression: investigated and NOT confirmed

**Claim investigated**: aggregate p95 at `WORKERS=6` (the simplest/default scenario) reportedly rose
from 994ms to 1,415ms after Round 4's timeout change, exceeding the 1s target in the baseline case.

**This does not hold up under controlled testing, and the evidence is reported here in full rather
than either accepted at face value or dismissed without checking.**

First pass (naive, all-of-config-A-then-all-of-config-B): timeout=8000ms × 3 runs gave agg p95
[1536, 788, 947]ms; timeout=1500ms × 3 runs gave [580, 1093, 586]ms — a difference that looked real
(means ~1,090ms vs ~753ms). But this ordering is itself a confound (later runs in a session can
benefit from OS/Postgres cache warming independent of config). **Redone interleaved** (A, B, A, B, not
grouped): timeout=8000ms gave [1150, 632]ms, timeout=1500ms gave [1077, 1479]ms. Combined across all
7 runs of each: timeout=8000ms mean ≈ 1,011ms (range 632-1,536), timeout=1500ms mean ≈ 963ms (range
580-1,479) — **nearly identical, heavily overlapping distributions**. Raising the pool timeout does
not reproducibly change `WORKERS=6` aggregate latency, which also makes structural sense: 6 workers
against pools of 8-12 essentially never queue, so a connection-acquire timeout is rarely even
exercised at this concurrency.

**What's actually driving the variance**: `aggregation_requests` count for these runs was only 23-27
(the local harness fires ~1 aggregate probe/second, and a `WORKERS=6` full-1M run only takes
~24-27 seconds). At that sample size, "p95" is mathematically almost the same index as "max" — one
occasional slow sample (autovacuum timing, OS scheduling jitter, a momentary heap-fetch hiccup)
single-handedly determines the reported figure. Confirmed directly: full latency breakdown for one
run was `p50=487ms, p95=1536ms, p99=1571ms, max=1571ms` — the **median is excellent** and the p95/p99/max
cluster together, the signature of one dominant outlier in a tiny sample, not a systematic problem.
The user's 994ms and 1,415ms data points are both plausible draws from this same noisy ~25-sample
distribution, independent of which timeout was configured.

**Conclusion**: no regression found; no fix applied. The underlying small-sample noisiness of the
local harness's `WORKERS=6` aggregate-p95 measurement is a pre-existing characteristic (present before
Round 4 too), not something Round 4 introduced. It is also likely not representative of how the
official benchmark measures this — the official stages run 2-3.67 minutes and would accumulate far
more aggregate samples per stage than this ~25-second local burst does.

### Part 2 — context.md compliance checklist

| Requirement (context.md) | Status | Evidence |
|---|---|---|
| `GET /health` — 200 only after DB connected + migrations applied + ready | ✅ Verified | `src/index.ts` orders `SELECT 1` → `migrate()` → `app.listen()`; unreachable before listening |
| `POST /logs` — exact request/response shape, 200 if ≥1 accepted, 400 if all rejected/malformed/wrong shape | ✅ Verified | `tests/api.integration.test.ts`, `scripts/audit-run.sh` (10 POST checks), controller code inspected |
| Per-entry validation: timestamp (ISO-8601, ≤5min future), level enum, service/message non-empty, attributes flat string/number/bool | ✅ Verified | `tests/log.validator.test.ts` (14 tests), `src/validators/log.validator.ts` inspected line-by-line |
| Batch behavior: invalid entry doesn't fail whole batch, index+reason per rejection | ✅ Verified | `tests/api.integration.test.ts` "ingests valid batches and partially rejects invalid entries" |
| `GET /logs` — service/level/since/until/attr.\<key\>/q, freely combinable | ✅ Verified | `tests/logs.repository.test.ts`, `tests/api.integration.test.ts` "combines filters" |
| `since` inclusive, `until` exclusive | ✅ Verified | Explicitly tested this round (Part-2 spot check, boundary timestamps) and in existing test suite |
| `limit` default 100, max 1000, non-numeric/out-of-range → 400 | ✅ Verified | `scripts/audit-run.sh` "GET limit max/default/invalid" |
| Descending `(timestamp,id)` order, deterministic on ties | ✅ Verified | `tests/api.integration.test.ts` "paginates deterministically when timestamps are equal" |
| Cursor opaque, invalid/malformed → 400 | ✅ Verified | `tests/api.integration.test.ts` invalid-cursor cases (4 variants) |
| `GET /logs/aggregate` — since/until/bucket required, group_by optional | ✅ Verified | Controller requires all three; `scripts/audit-run.sh` "aggregate invalid params" |
| Buckets ascending, empty omitted, `group: null` when ungrouped | ✅ Verified | `tests/api.integration.test.ts` "aggregates all buckets... validates aggregation input" |
| Invalid query params → 400 `{"error": "..."}` (same shape both endpoints) | ✅ Verified | Both controllers share `getAttributeFilters`/timestamp/limit validation helpers |
| Retention: configurable, bounded batches, no long-running locks | ✅ Verified | `FOR UPDATE SKIP LOCKED`, `RETENTION_BATCH_SIZE`/`RETENTION_MAX_BATCHES`, `tests/retention.service.test.ts` |
| `docker compose up` zero-config serves full unauthenticated core contract | ✅ Verified | Repeated fresh `down -v` + `up --build` cycles this round, all four endpoints reachable, no env file |
| SQL injection surface | ✅ Verified clean | Re-swept every repository file this round (Round 4) and again spot-checked this round — all Drizzle tagged `sql` templates or parameterized query builder |
| README covers all 8 required topics | ✅ Verified | Section headers present: Quick start, API and validation, Schema/indexes/retention, Configuration, Measured performance, Known limitations — all 8 context.md topics covered across these sections |
| CI pipeline unaffected by pool/config changes | ✅ Verified | `.github/workflows/ci.yml` uses `npm test` + `docker compose up --build -d`; all new env vars are optional/defaulted, no CI changes needed |

**Minor observation, not a compliance gap**: `GET /logs/aggregate` with `group_by` orders by bucket
start ascending (as required) but does not additionally guarantee a deterministic order *between*
groups sharing the same bucket start — context.md's explicit determinism requirement ("ordering must
remain deterministic when multiple logs have the same timestamp") is stated only for `GET /logs`, not
for the aggregate endpoint's group ordering within a bucket. Not changed; flagged for awareness only.

**Everything in this table was independently re-verified this round**, not assumed carried-over from
earlier rounds.

### Part 3 — query-latency reduction, and an important variance discovery

**Change (Attempt 1 of 2 allowed)**: gave the query pool its own, shorter connection-acquire timeout
(`DB_QUERY_POOL_CONNECT_TIMEOUT_MS`, default 2500ms) separate from the ingest pool's 8000ms. Rationale:
ingestion can tolerate waiting for a connection (a slow-but-accepted COPY beats a dropped batch), but a
query that waits up to 8s just to then run is exactly what was inflating `GET /logs/aggregate`'s own
p95 under heavy load, without helping ingestion at all.

**Result — large, real latency improvement**:

| Scenario | Aggregate p95 before (shared 8000ms) | Aggregate p95 after (query=2500ms) |
|---|---:|---:|
| `WORKERS=64`, batch=2500 | 6,191ms (Round 4 report) | 2,836ms |
| `WORKERS=128`, batch=2500 | 22,186ms (Round 4 report) | 2,835ms |

**Critical discovery made while validating this change — reported in full even though it complicates
the picture**: the first single-run A/B at `WORKERS=128` showed 35,000 dropped logs with the new
config, which looked like a regression against Round 4's "zero drops" claim. Investigating this
properly (fresh-volume re-runs, not reused containers) revealed something more fundamental: **the
exact Round-4-shipped configuration itself (query and ingest timeouts both 8000ms — i.e., no Part-3
change at all) produced 6.75%, 12.75%, and 27% drop rates across three fresh-volume `WORKERS=128` runs.**
This is not something Part 3 caused — `WORKERS=128` with a full sustained 1,000,000-row run is
genuinely high-variance in this environment, regardless of query-pool configuration, under the fixed
0.5 CPU/1 CPU resource envelope. A fair, matched comparison (3 fresh-volume runs each):

| Config | Run 1 dropped | Run 2 dropped | Run 3 dropped | Mean dropped |
|---|---:|---:|---:|---:|
| Shared 8000ms (Round 4, no Part-3 change) | 270,000 | 67,500 | 127,500 | 155,000 (15.5%) |
| Query=2500ms (Part 3) | 210,000 | 65,000 | 35,000 | 103,333 (10.3%) |

The Part-3 change does not clearly worsen the drop rate at `WORKERS=128` — if anything the mean is
somewhat better, though both distributions are wide and overlap substantially; n=3 per side is not
enough to call this a confirmed improvement on the drop axis, only "not worse." **`WORKERS=6/16/64`
remain reliably at zero drops** across every run this round, including with the Part-3 change, at
batch sizes 300/1000/2500 — the instability is specific to `WORKERS=128`.

**Decision**: shipped the query-pool-timeout split. It delivers a large, clearly real improvement on
its stated goal (query latency) and does not demonstrate a regression on the drop-rate floor at the
concurrency levels that were previously reliable (6/16/64). `WORKERS=128`'s inherent variance is a
pre-existing characteristic of operating at the edge of this fixed resource envelope, not a new problem
introduced here — documented as a known limitation below rather than chased with a third config
change, per the time-boxed guidance for this round.

**Not pursued (would have been Attempt 2)**: further tuning specifically aimed at stabilizing
`WORKERS=128`'s drop rate. Given the demonstrated noise floor (73-99% accepted on the *identical*
config across different runs), any further config tweak would need many more than 3 samples per
candidate to distinguish real signal from this noise — a reasonable next step, but a poor fit for
this round's time budget after the first attempt's goal (latency) was already met.

### Final validation, Round 5

`npm run typecheck && npm run build`: clean. `docker compose --profile test run --rm test`: 42/42
pass. `scripts/audit-run.sh`: 30/30 pass. Full matrix re-confirmed with the final config
(`DB_QUERY_POOL_CONNECT_TIMEOUT_MS=2500`): `WORKERS` 16/64 × `BATCH_SIZE` 300/1000 all zero drops;
`WORKERS=128`/batch=2500 variable (see above, not zero-drop-guaranteed, documented honestly).

## Round 6 — official re-submission after the Phase 0 timeout revert (2026-08-15)

**Change re-validated**: exactly the two-line revert of `DB_QUERY_POOL_CONNECT_TIMEOUT_MS`'s
default, 2500ms → 8000ms, in `docker-compose.yml` and `src/config/env.ts` (commit `44358f2`,
diffed directly against `7e217a3` — no other file touched). Submitted officially as
`test3.pdf` (`5KWYNVF6ZXER8R13SWN9E3Y4YD`): **59.49/100, rank #24** (test1: 59.40/#15, test2:
45.51/#49).

### Score breakdown, all three submissions

| Category | test1 (`3416eb3`) | test2 (`7e217a3`) | test3 (`44358f2`) |
|---|---:|---:|---:|
| Performance | 18.40/50.00 | 4.51/50.00 | **18.49/50.00** |
| Reliability | 20.00/20.00 | 20.00/20.00 | 20.00/20.00 |
| Correctness | 15.00/15.00 | 15.00/15.00 | 15.00/15.00 |
| Queries | 6.00/15.00 | 6.00/15.00 | 6.00/15.00 |
| Correctness checks | 75/75 | 75/75 | 75/75 |

Reliability, Correctness, and Queries are byte-identical across all three official runs. The
entire 59.40→45.51→59.49 swing is 100% a Performance-category effect — confirms this diff is a
Performance-only lever with no measurable side effect on any other scored category.

### Full per-stage extraction, all three runs

**Load** (15,000 logs/s flat, 120s)

| Metric | test1 | test2 | test3 |
|---|---:|---:|---:|
| HTTP Requests | 9.18K | 12.18K | 9.42K |
| Accepted Logs | 305.9K | 405.9K | 314.1K |
| Logs/s | 2549.17 | 3382.50 | 2617.50 |
| Latency p95 | 3.87s | 2.90s | 5.00s |
| Ingestion Latency p95 | 3.64s | 2.47s | 2.66s |
| Aggregate P95 | 4.08s | 3.10s | 5.50s |
| Error Rate | 0.00% | 14.46% | 0.00% |
| App CPU max/avg | 19.55%/5.78% | 40.07%/8.80% | 53.82%/10.34% |
| PG CPU max/avg | 105.55%/73.52% | 102.70%/75.89% | 103.03%/73.38% |
| Read-After-Write Success Rate | 0.03% | 1.58% | 1.05% |
| EC Drain | 3.28s | 8.98s | 7.04s |

**Stress** (15,000→22,500→30,000 logs/s, 150s)

| Metric | test1 | test2 | test3 |
|---|---:|---:|---:|
| HTTP Requests | 5.9K | 12.26K | 5.95K |
| Accepted Logs | 175.4K | 408.6K | 198.2K |
| Logs/s | 1169.33 | 2724.00 | 1321.33 |
| Latency p95 | 5.51s | 3.30s | 7.60s |
| Ingestion Latency p95 | 5.08s | 853.41ms | 878.17ms |
| Aggregate P95 | 5.79s | 3.69s | 8.00s |
| Error Rate | 15.14% | 39.38% | 0.08% |
| App CPU max/avg | 20.08%/5.04% | 16.16%/7.45% | 16.56%/4.41% |
| PG CPU max/avg | 107.09%/82.09% | 103.97%/81.57% | 101.58%/79.22% |
| Read-After-Write Success Rate | 0.06% | 0.02% | 0.05% |
| EC Drain | 1.91s | 9.28s | 4.61s |

**Spike** (7,500→30,000 (10s)→7,500 logs/s, 100s)

| Metric | test1 | test2 | test3 |
|---|---:|---:|---:|
| HTTP Requests | 2.95K | 4.47K | 3.03K |
| Accepted Logs | 98.4K | 149.1K | 100.9K |
| Logs/s | 984.00 | 1491.00 | 1009.00 |
| Latency p95 | 4.34s | 3.50s | 5.10s |
| Ingestion Latency p95 | 4.27s | 681.63ms | 892.65ms |
| Aggregate P95 | 4.60s | 3.91s | 5.51s |
| Error Rate | 0.00% | 24.28% | 0.00% |
| App CPU max/avg | 8.69%/3.02% | 20.46%/5.28% | 11.24%/3.30% |
| PG CPU max/avg | 100.02%/74.34% | 103.18%/75.40% | 101.77%/74.94% |
| Read-After-Write Success Rate | 0.10% | 0.07% | 0.10% |
| EC Drain | 1.03s | 3.29s | 2.29s |

**Breakpoint** (15,000→22,500→30,000→45,000 logs/s, 120s)

| Metric | test1 | test2 | test3 |
|---|---:|---:|---:|
| HTTP Requests | 5.26K | 9.67K | 4.44K |
| Accepted Logs | 161.4K | 322.2K | 148.1K |
| Logs/s | 1345.00 | 2685.00 | 1234.17 |
| Latency p95 | 5.40s | 3.51s | 8.11s |
| Ingestion Latency p95 | 5.00s | 1.47s | 1.69s |
| Aggregate P95 | 5.99s | 4.23s | 8.91s |
| Error Rate | 22.10% | 46.43% | 12.13% |
| App CPU max/avg | 7.95%/3.13% | 9.08%/4.53% | 11.95%/3.27% |
| PG CPU max/avg | 100.14%/70.59% | 102.97%/78.04% | 101.08%/78.60% |
| Read-After-Write Success Rate | 0.06% | 0.03% | 0.07% |
| EC Drain | 1.67s | 7.07s | 3.34s |

(App/Postgres memory stayed within a tight, uninteresting band across all three runs —
55–66 MiB app, 505–573 MiB Postgres — in every stage; not reproduced per-stage here.)

### Metric-to-diff causal linkage

The diff changes exactly one thing: how long `GET /logs` and `GET /logs/aggregate` may wait for
a `queryPool` connection before being shed with 503 (`dbQueryPoolConnectTimeoutMs`, consumed
only in `src/db/index.ts`'s `queryPool`). `ingestPool` (POST /logs) and all query logic/schema/
indexes are untouched.

**Direct test of the mechanism — error rate present iff Aggregate P95 exceeds that submission's
budget:**

| Stage | test1 (budget 5000ms) | test2 (budget 2500ms) | test3 (budget 8000ms) |
|---|---|---|---|
| Load | P95 4.08s < 5.0 → 0.00% ✓ | P95 3.10s > 2.5 → 14.46% ✓ | P95 5.50s < 8.0 → 0.00% ✓ |
| Stress | P95 5.79s > 5.0 → 15.14% ✓ | P95 3.69s > 2.5 → 39.38% ✓ | P95 8.00s ≈ 8.0 (boundary) → 0.08% ✓ |
| Spike | P95 4.60s < 5.0 → 0.00% ✓ | P95 3.91s > 2.5 → 24.28% ✓ | P95 5.51s < 8.0 → 0.00% ✓ |
| Breakpoint | P95 5.99s > 5.0 → 22.10% ✓ | P95 4.23s > 2.5 → 46.43% ✓ | P95 8.91s > 8.0 → 12.13% ✓ |

11 of 12 stage×run combinations across three independent official submissions match the model
exactly; the 12th (test3 Stress) sits at the boundary and produces a correspondingly tiny
non-zero error rather than a large one. This is confirmed prediction against data the model
didn't see when `44358f2`'s commit message was written, not a post-hoc story.

**Explained by the diff:**
- **Error rate, all 4 stages** — directly, via the mechanism above.
- **Accepted logs / logs-per-second, all 4 stages (dropped from test2)** — second-order effect
  of the same mechanism, running in reverse of the original test1→test2 regression: test2's
  fast-fail 503s freed Postgres/app capacity that ingestion opportunistically absorbed,
  inflating throughput; restoring the 8000ms budget lets GET requests actually complete and
  compete for that capacity again. Load/Stress/Spike settle close to test1's level; Breakpoint
  undershoots test1 by ~8% (148.1K vs 161.4K) — real but small, likely infra variance (see below).
- **HTTP request count, all 4 stages** — same explanation.
- **Drain time (fell from test2, but above test1)** — downstream of the throughput reversion:
  drain scales with backlog size, and test3's accepted volume sits between test1's and test2's
  in every stage.
- **Postgres CPU (flat across all three runs)** — correctly *unaffected*: this diff changes
  connection-pool wait behavior only, not Postgres-side work per query. PG CPU pinned at
  100–107% max / 70–82% avg in all three submissions, regardless of this setting, is a
  confirmation of the mechanism and continues to point at Postgres compute as the structural
  bottleneck.

**Not explained by the diff (flagged, not forced into a story):**
- **Ingestion Latency p95 (Stress/Spike/Breakpoint stayed near test2's much-improved values,
  not test1's)** — plausibly because it's dominated by the ingest pool (unchanged at 8000ms in
  every run) and COPY batch service time rather than the query pool this diff touches, but the
  test1→test2 improvement itself predates this diff and isn't independently explained here.
- **Load-stage App CPU max (53.82%, above both test1's 19.55% and test2's 40.07%)** — avg in
  the same stage is only 10.34%, so this is a single 5-second sampling spike, not sustained
  pressure. Most likely container-scheduling jitter or a `docker stats` sampling artifact
  (a known caveat from earlier rounds); nothing in the two-line diff touches app compute.
- **Read-After-Write Success Rate (0.02%–1.58%, no clean direction)** — bounces around with no
  relationship to the timeout value. Notably, the Queries score component (6.00/15.00) is
  identical across all three submissions despite this metric swinging 79x between runs — direct
  evidence against the earlier working hypothesis that this number is the Queries-score lever
  (see "what to adjust next" below).
- **Absolute Aggregate P95 magnitude differs between test1 and test3 despite similarly
  non-restrictive budgets** (test1 worst case 5.99s vs test3 worst case 8.91s) — the diff
  doesn't change query cost. test1 and test3 were submitted ~43 hours apart; most plausibly
  day-to-day grader-infrastructure variance, consistent with this host running faster per-core
  than the grader's (documented earlier) and Postgres sitting pegged near its ceiling in every
  run, where small infra differences show up directly as P95 swings.

### Prediction check (against `44358f2`'s commit message)

Predicted: *"error rates should return to roughly test1's shape (0%/~15%/0%/~22%) or better with
Performance recovering toward ~18-24 of 50, while throughput stays near test2's higher figures
since the ingest path is untouched."*

| Claim | Predicted | Actual | Verdict |
|---|---|---|---|
| Error rate shape | 0%/~15%/0%/~22% or better | 0.00%/0.08%/0.00%/12.13% | **Held, beat target** — equal in Load/Spike, much better in Stress and Breakpoint |
| Performance score | ~18–24/50 | 18.49/50 | **Held**, low end of range |
| Throughput near test2 | Stays near test2's figures | Reverted close to (Breakpoint: slightly below) test1's figures | **Did not hold** |

The throughput claim was wrong because it assumed unchanged ingest-path *code* meant unchanged
ingest-path *behavior*, without carrying through the capacity-competition mechanism already
established for the original regression (in reverse). The error-rate and Performance-score
predictions, built directly on the budget-vs-P95 model, held.

### What to adjust next (grounded in this round's data)

1. **Aggregate P95, not the timeout budget, is now the Performance ceiling.** Even at 0%
   shedding, Stress/Breakpoint P95 (8.00s/8.91s) sit 8-9x over the stated <1s target, and the
   budget is already above the worst observed P95 in either run — raising it further only
   delays failures. Moving Performance materially past ~18.5/50 requires making the aggregate
   query itself faster (R1's rollup-table direction). Note: the R1 prototype snapshot from the
   prior session no longer exists on disk (scratchpad was wiped between sessions, no stash/
   branch holds it) — it would need to be rebuilt from scratch, not resumed.
2. **Breakpoint is the worst stage in all three submissions**, and Postgres CPU sits at
   100-107% in every run of it regardless of timeout config — three-for-three evidence,
   independent of this diff, that Postgres compute is the structural bottleneck at the
   45,000 logs/s peak this stage reaches.
3. **The Queries score (6.00/15.00) did not move across a 79x swing in read-after-write success
   rate (0.02%→1.58%) over three official runs.** Recommend deprioritizing further
   read-after-write investigation as the Queries lever; it doesn't track this metric in this
   range. The only other Queries-adjacent signal that moved at all in this data is query
   latency itself.
4. **Rank fell #15→#24 despite an equal-or-better score (59.40→59.49)** — leaderboard
   composition drift over the ~43-hour gap between submissions, not a regression on this side.
5. Two data points remain unexplained by any code change and are flagged rather than acted on:
   the Load-stage App CPU max spike (likely sampling artifact) and the ~3s gap between test1's
   and test3's worst-case Aggregate P95 under comparably non-restrictive budgets (likely
   day-to-day infra variance).

## Round 7 — Queries-gap re-investigation: query CORRECTNESS under concurrent load (2026-08-15, later still)

Scope: the Queries score (6.00/15.00) has been identical across all three official submissions
(test1/test2/test3) despite Correctness sitting at a perfect 15.00/15.00. Round 3 covered query
*availability* under load (the 500-vs-503 bug, fixed) and one correctness issue (pagination
misses under concurrent writes, diagnosed as inherent). This round re-investigates query
*correctness* specifically, targeting four threads, and re-tests the pagination finding's
"unfixable" conclusion rather than accepting it on faith.

**Environment caveat**: `docker` was unreachable in this session (WSL integration disabled).
Ran directly against native Postgres 18.4 with GUCs matched to `docker-compose.yml` where
reloadable without a restart (`work_mem=32MB`, `max_wal_size=4GB`, `effective_cache_size=768MB`,
`random_page_cost=1.1`); `shared_buffers` stuck at the default 128MB (needs a restart, no `sudo`
available). No cgroup CPU/memory limits (0.5/1 CPU) were enforced — this host is unconstrained.
The corrected-composition harness (50.5 POST/s batch=67, 25 `q=` read-after-write probes/s, 1
aggregate/s) was rebuilt from scratch, as the prior session's scratchpad tooling had been wiped.
Numbers below are real, reproducible evidence that a mechanism exists and its rough order of
magnitude — not a precise prediction of official-instance magnitudes.

### Thread 1 — cursor-pagination sweep misses, quantified

Baseline (page=100, unbounded, ~3,400 logs/s write rate): **4.4%-6.5% miss rate across four
independent runs** (4,079/92,513=4.41%; 4,726/82,257=5.75%; 5,652/97,573=5.79%;
9,708/149,463=6.50%), **0 duplicates in every run**. Page=1000 gave a similar 4.27%
(5,501/128,750) — page size is not a major lever. This is the same phenomenon Round 3 found
(there: 12-20%, seeded once); the lower rate here is consistent with a faster local sweep
(2.4-5.4s) having less wall-clock exposure to the race, not a contradiction.

**Watermark/lag-margin mitigation — built and tested, does not work.** Bounded the sweep with
`until = sweepStart - margin`, using the endpoint's own already-supported `until` parameter (no
contract change). Order-counterbalanced to rule out "later runs are slower" as a confound:

| Margin | Order | Missed/Expected | Miss rate |
|---|---|---:|---:|
| 60s | first | 7,738/91,521 | 8.45% |
| 0s | second | 9,708/149,463 | 6.50% |
| 0s | first | 4,079/92,513 | 4.41% |
| 60s | second | 25,699/171,648 | 14.97% (also had a duration confound, noted) |

A 60-second watermark did not reduce the miss rate in either ordering — both times it was
higher than the unbounded baseline. `EXPLAIN (ANALYZE, BUFFERS)` confirmed this isn't a query-
plan artifact: both bounded and unbounded queries use a clean `Index Scan Backward` on the
primary key, sub-millisecond either way.

**Why it doesn't work, mechanically**: the "danger zone" for a miss is not a thin band near
`now()` — it is the entire portion of the timestamp range already swept, which grows for the
whole sweep duration. A small watermark only excludes a thin recent slice; it does nothing to
protect the rest of the range once the sweep has passed through it. Since the system correctly
allows arbitrary-depth backfill (verified directly in `log.validator.ts` — no minimum-age check)
and the workload is required to scatter data across "approximately one month" (context.md), a
new row can arrive at any moment with a declared timestamp landing anywhere in that 30-day span,
including deep inside the already-swept region, regardless of a small margin's size. Only a
margin approaching the full backfill depth (~30 days) would meaningfully help, which defeats the
purpose of a "give me current data" query.

**Verdict: Round 3's Finding 2 is reaffirmed, now with real numbers and a specifically-tested
mitigation that failed twice under order control.** Not fixable within the exact required
contract (DESC sort, keyset cursor, opaque cursor, client-supplied unbounded-past timestamps)
without either changing the sort contract or bounding backfill depth — neither ours to do
without a Golden Rule violation.

### Thread 2 — aggregate bucket-count accuracy under concurrent writes

Repeated `GET /logs/aggregate` calls (0.5-1s cadence) during active ingestion across 4 scenario
shapes (1h/1m, 1h/1m/groupBy=service, 6h/5m/groupBy=level, 1d/1h), each immediately followed by
a direct SQL query bounded by `created_at` (server-assigned insertion time — race-free, since it
only fires after the app's response and the table is append-only in this window; a direct count
taken strictly afterward can only be >= the app's own count, never less, so any overcount would
be a proven bug).

**Result: 0 overcounts across 8,547 bucket-level comparisons.** The only discrepancies were
small undercounts (max 3.1%), consistent with ordinary MVCC visibility lag, not miscounting.
31/60 iterations hit 503 (pool shed under the same already-documented contention) — an
availability effect, not a correctness one.

**Verdict: no bucket-arithmetic bugs found.** Confirms Round 3's Finding 3 with a race-free
method instead of the earlier two-independent-snapshots argument.

### Thread 3 — filter-combination correctness under load

Walked 8 filter combinations to full completion during active ingestion (service-only,
level-only, attr-only, q-only, and progressively combined up to service+level+attr+q), each
compared against a direct SQL query with the identical predicate, plus a live check that every
returned row actually satisfies every requested filter (catches false positives, not just
misses).

**Result: 0 missed rows, 0 false positives, 0 duplicates across all 8 combinations and
>1,000,000 total swept rows**, including the fully-combined 4-predicate filter and a narrow
single-user `attr.user_id` filter. The narrower matching rate of combined filters likely explains
why these showed no exposure to Thread 1's race at similar total volumes -- fewer new writes
qualify per second, not a different mechanism.

**Verdict: filter logic is correct under load.**

### Thread 4 — response-shape byte-level checks

| Check | Result |
|---|---|
| Empty buckets | `{"buckets":[]}` — literal empty array |
| `group` when no `group_by` | `"group":null` — literal JSON null, confirmed byte-for-byte |
| `group` with `group_by=service` | correct per-service values, one row per non-empty group |
| Bucket ordering | ascending, confirmed programmatically |
| `next_cursor` when exhausted | `"next_cursor":null` — literal null |
| `next_cursor` when more results exist | valid opaque base64url string |
| Invalid params (bucket/since-until/cursor/limit/duplicate query param) | all correct `400 {"error":"..."}` |

**Verdict: no shape bugs found.**

### Outcome and a known limitation, explicitly unresolved

Of the four threads, only Thread 1 is a real, reproducible defect, and it is now confirmed
genuinely unfixable within the exact required contract rather than assumed so. Threads 2-4 came
back clean under deliberately adversarial conditions (concurrent writes, combined filters,
edge-case parameters).

**This does NOT fully explain the Queries score gap.** Thread 1's defect only affects a client
doing a full historical sweep of `GET /logs`; the corrected-composition harness's actual read
pattern is targeted `q=` probes (25/s) and periodic aggregate calls (1/s), not a table sweep.
There is no evidence the official grader performs the kind of sweep that would trigger Thread
1's defect at all. **The Queries gap (6.00/15.00, identical across three official submissions)
remains a known limitation, not fully explained by any correctness defect found to date.**
Recorded here explicitly rather than left implicit, per standing instruction not to force a
connection that isn't demonstrated.

## Round 8 — R1 rollup table, rebuilt from scratch (2026-08-15, later still)

Scope: rebuild the incremental rollup table for `GET /logs/aggregate`, targeting the confirmed
structural bottleneck (Postgres CPU pinned at 100-107% in every stage of all three official
submissions, independent of pool/timeout config). The prior prototype was lost when the
scratchpad was wiped between sessions — this is a full rebuild, not a resume, including
re-deriving and re-verifying the boundary-handling design rather than assuming it still holds.

**Environment caveat, unchanged from Round 7**: `docker` was unreachable this session. All
measurement below ran on native, unconstrained Postgres 18.4 (no 0.5/1 CPU cgroup limits). The
correctness work (differential testing) is fully valid regardless of resource limits. The
performance numbers are NOT comparable to official-instance magnitudes and are flagged as such
throughout — they are relative WITH-vs-WITHOUT evidence on this host only.

### Design (stated before implementation)

**Schema**: `logs_rollup(bucket_minute, service, level, shard, count)`, primary key on all four
non-count columns. `bucket_minute` is a 1-minute `date_bin` against the same fixed origin
(`2026-01-01T00:00:00Z`) the live query uses — since 1m/5m/1h/1d are all exact multiples of 1
minute sharing that origin, `date_bin(largerBucket, bucket_minute, ORIGIN)` is always exactly
equal to `date_bin(largerBucket, timestamp, ORIGIN)` for any row in that minute. Re-binning
rollup rows to a larger requested bucket is exact, not an approximation.

**Maintenance**: incremental, in the same transaction as each ingestion batch's COPY (BEGIN →
COPY → set-based rollup upsert → COMMIT). Deltas are grouped in JS by (minute, service, level),
sorted before the upsert, applied via one `INSERT ... SELECT unnest(...) ON CONFLICT DO UPDATE`
statement regardless of batch size — no per-row triggers, matching the standing instruction. The
statement's own `ORDER BY` re-asserts the sort, so any two concurrent transactions acquire row
locks in the same global order — deadlock avoidance by construction, not retry logic. A `shard`
column (16 shards, one per pooled ingest connection via `client.processID % 16`, readers always
sum across shards) reduces hot-row lock contention from concurrent batches landing on the same
(bucket, service, level).

**Consistency model**: rollup is never stale relative to `logs` for any durably-accepted batch —
if the rollup upsert fails, the whole transaction (including the COPY) rolls back. Retention
needed a matching fix (see below) to keep counts accurate once old data ages out.

**message/attr.\<key\> filters**: never pre-aggregated (unbounded cardinality) — always fall back
to the live query path. Documented, not hidden, and covered by the differential test.

**Boundary handling**: `logs_rollup` stores whole-minute counts, so a request whose `[since,
until)` doesn't align to minute boundaries has two partial-minute "edge slivers" the rollup
can't answer alone. These are always served by a narrow live query (each spans at most one
minute — cheap regardless of table size); the fully-contained whole minutes between them (the
"body") are served by the rollup. This is correct for ANY since/until, not just an aligned one.

### Verifying the carried-over assumption

The lost prototype's assumption was that the official grader's window shape (`since =
test-start - 60s`, `until = now + 60s`) makes the head/tail edge slivers naturally empty — no
data exists before test start, and `until` is always in the future. Verified empirically this
round, against real data (query run directly against Postgres, not asserted):

```
head_sliver_rows | tail_sliver_rows
------------------+------------------
                0 |                0
```

**Confirmed.** For this specific window shape, both edge slivers are provably empty, so the
extra live queries the general-case implementation always issues cost essentially nothing for
the actual official workload — while still being fully correct for any other caller's window,
which the lost prototype reportedly did not guarantee. This is real, more robust than assumed
away.

### Correctness verification

A differential test (`r1-diff.mjs`) compared the app's `GET /logs/aggregate` (rollup-backed)
against an independent ground-truth SQL query computed directly against `logs` alone (never
touches `logs_rollup`) across 19 scenarios: minute-aligned windows, deliberately misaligned
windows (head/tail slivers), sub-minute windows, the official-shaped window at three bucket
sizes, empty windows (far past and future), and message/attr filter fallback cases.

**First pass: 18/19 matched, one real bug found.** A sub-minute, non-minute-aligned window (e.g.
`since=00:00:10, until=00:00:50`) produced a doubled count. Root cause: when the window is
narrower than a minute and doesn't straddle a boundary, `ceilToMinute(since) > floorToMinute(until)`
— the head and tail slivers as originally defined are no longer disjoint, and both end up
covering (and double-counting) the same rows. **Fixed**: when there's no valid non-empty rollup
body, the whole window falls through to one live query instead of a head+tail decomposition.
Exactly the kind of thing this differential test exists to catch — not a hypothetical, a real
defect in the first implementation.

**Second pass: 19/19 matched** after the fix. A separate anomaly (one orphaned rollup row with no
matching `logs` row) surfaced during manual investigation and was traced to test/session
cross-contamination (the migration's backfill ran once against stale leftover data from a prior
investigation, before this round's tables were truncated) — reproduced zero times against a
freshly truncated, single-generation dataset (`logs_rollup` vs `logs` compared directly: 0
orphans, 0 sum mismatches, across the full dataset both directions). Not a defect in the write
path; noted here rather than silently dropped.

`npm test`: 43/43 (test fixtures for `logs.repository.test.ts` and `api.integration.test.ts`
updated to also reset `logs_rollup` between tests — the same fixture gap Round 6/prior sessions
found for the lost prototype recurred here and was fixed the same way).

### Retention fix (re-applied)

`deleteOrphanedRollupBuckets()` re-implemented with the `coalesce(..., 'infinity')` guard: a
rollup bucket is deleted once it's strictly older than the oldest surviving log's own bucket (or
everything, if `logs` is empty) — the naive `IS NOT NULL` version silently stops cleaning up
forever once `logs` is fully emptied, exactly the bug found and fixed in an earlier round for the
lost prototype.

### Write-path cost

Isolated POST-only measurement (`write-cost.mjs`, batch=67, 12 workers, 30s, fresh table each
run), two samples per condition:

| Condition | Sample 1 | Sample 2 | Avg |
|---|---:|---:|---:|
| Without rollup | 50,886 logs/s | 50,019 logs/s | 50,453 logs/s |
| With rollup | 39,947 logs/s | 41,180 logs/s | 40,564 logs/s |

**~19.6% ingestion throughput cost** at this (small, freshly-growing) table scale.

**A second, larger-scale measurement changed the picture**: at a ~5,000,000-row `logs_rollup`
(2.78M distinct bucket/service/level/shard combinations — the accumulated rollup index itself,
not `logs`), a combined ingestion+aggregate+rollup-maintenance test showed ingestion drop from
43,209 logs/s (without) to 21,481 logs/s (with) — roughly 50%, well above the small-scale
estimate. **The rollup upsert's cost appears to grow with the rollup table's own accumulated
size** (larger B-tree, deeper index), not just with per-batch delta count — a real scaling
concern this round did not have time to characterize further, flagged rather than glossed over.

### Read-path benefit — genuinely mixed, not a clean win

Two test conditions, same Breakpoint-level ingestion pressure (36 workers), differing only in
the aggregate query's own window:

**Narrow rolling window (1 hour lookback)** — cheap regardless of rollup, since only ~0.1% of
the scattered-30-day dataset falls in any 1-hour slice:

| Condition | agg p50 | agg p95 | PG CPU avg | PG CPU max |
|---|---:|---:|---:|---:|
| Without rollup | 22ms | 162ms | 166.4% | 185.4% |
| With rollup | 99ms | 112ms | 159.7% | 174.9% |

No clear win here — p50 is worse with rollup (dispatch overhead across body+head+tail for a
query the live path already answers cheaply), p95/CPU roughly a wash. **This window shape does
not resemble the official grader's actual aggregate query.**

**Full-history window (`since` = 35 days back, `until` = now)** — matches the official grader's
actual shape (`since = test-start - 60s`), at ~5,000,000 rows:

| Condition | agg p50 | agg p95 | PG CPU avg | PG CPU max | logs/s |
|---|---:|---:|---:|---:|---:|
| Without rollup | 2,501ms | 3,053ms | 294.9% | 320.2% | 43,209 |
| With rollup | 628ms | 798ms | 238.7% | 436.9% | 21,481 |

**Here the rollup shows a real, large win on the metric the spec actually targets**: aggregate
latency down ~75% (p50 and p95 both), Postgres CPU average down ~19%. But CPU *max* went up
(320→437%), and ingestion throughput roughly halved under this combined load — consistent with
the write-path finding above that upsert cost scales with rollup table size, now clearly visible
as a real trade-off rather than a clean net positive.

### Verdict — R1 does not move the needle as expected, and that's said plainly here

The benefit is real but narrow: it only shows up when both (a) the aggregate query's window is
shaped like the official grader's actual query (full-history, not a rolling slice) and (b) the
dataset has grown large enough that a live full scan is genuinely expensive. At smaller scale or
narrower windows, it's a wash or a loss. The cost is real and was originally underestimated: not
a flat ~20% ingestion tax, but one that grows with the rollup table's own accumulated size,
observed as high as ~50% under combined Breakpoint-level pressure at ~5M rows -- exactly the
regime where Postgres CPU is already the confirmed bottleneck in every official run. **Whether
this net trade-off is worth shipping cannot be answered from this environment**: the official
instance's hard 1-CPU Postgres limit and 0.5-CPU app limit change both sides of this trade-off
in ways this unconstrained host cannot reproduce, and Docker was unavailable to test under the
real limits this round. This is reported as an open question, not resolved into a recommendation
either way, per the standing instruction to say plainly when a proposed fix does not clearly move
the needle rather than reframe a mixed result as a win.

### What was NOT done this round, explicitly

- No A/B under actual 0.5/1 CPU cgroup limits (Docker unavailable).
- Write-path cost scaling with rollup-table size was observed but not characterized as a curve
  (only two data points: small-scale ~20%, ~5M-row scale ~50%) — the actual shape of that curve,
  and whether it plateaus or keeps growing, is unmeasured.
- No official submission. No commit, no push, per standing instruction.


## Round 9 — R1 re-measured under REAL resource limits (2026-08-16)

Docker became available this session (WSL integration enabled by the user). Re-ran R1's
performance A/B under the actual `docker-compose.yml` limits (0.5 CPU/256MB app, 1 CPU/1GB
Postgres, verified directly: `docker inspect` showed `NanoCpus: 500000000`/`Memory: 268435456`
for app and `1000000000`/`1073741824` for postgres) instead of the unconstrained native host
Round 8 used. CPU/memory sampled via `docker stats` (host-relative %, so a 1.0-CPU-limited
container tops out near 100% and a 0.5-CPU one near 50% — the same convention the official PDF
reports use, confirmed by matching magnitude to the official "100-107%" Postgres CPU pattern).

### The corrected-composition harness, under real limits: no measurable difference

Ran the validated corrected composition (50.5 POST/s, batch=67, 25 `q=` probes/s, 1 aggregate/s,
official-shaped full-history aggregate window) for 90s, WITH vs WITHOUT rollup:

| Metric | Without rollup | With rollup |
|---|---:|---:|
| logs/s | 1,124.86 | 1,130.07 |
| Aggregate p50 / p95 / max | 5 / 6,065 / 6,079 ms | 6 / 4,911 / 6,106 ms |
| Postgres CPU avg / max | 25.6% / 97.8% | 26.5% / 98.3% |
| App CPU avg / max | 0.87% / 5.9% | 2.2% / 8.2% |

Essentially identical throughput (0.4% apart, noise-level) and comparable latency/CPU either
way. At the corrected composition's realistic, moderate rate, neither condition saturates the
system enough for the rollup to matter -- there's slack on both sides regardless.

### At real Breakpoint-level pressure and realistic data scale: rollup measurably WORSE

The corrected composition alone doesn't reproduce Breakpoint's actual pressure (it's the
*achieved* rate under the old degraded config, not Breakpoint's *offered* rate). Pushed 36
concurrent ingest workers (proxying Breakpoint's peak target) against a dataset first grown to
realistic scale (~2.6-3.9M rows) via sustained ~5-minute seeding runs, matching the "~1,000,000
records" scale context.md specifies -- this is the condition Round 8's unconstrained numbers were
measured under, now re-run with the real limits actually enforced:

| Metric | Without rollup (~3.86M rows) | With rollup (~2.63M rows) |
|---|---:|---:|
| logs/s | 2,261.95 | 1,245.17 |
| Aggregate p50 / p95 / max | 3,274 / 6,308 / 6,308 ms | 3,620 / 8,238 / 8,238 ms |
| Postgres CPU avg / max | 35.1% / 97.9% | 42.5% / 98.1% |
| App CPU avg / max | 8.8% / 33.6% | 10.5% / 38.2% |

**Every metric is worse with the rollup at this scale under real limits**: ~45% lower ingestion
throughput, ~11-31% higher aggregate latency (p50/p95/max all worse, not better), and Postgres
CPU average *higher*, not lower. This directly contradicts Round 8's unconstrained-environment
finding, where the same comparison (large scale, full-history window) showed a large rollup win
(aggregate p50 2,501ms->628ms, CPU avg 294.9%->238.7%).

**Why the result flips**: Round 8's host had multiple free CPU cores, so the rollup upsert's own
cost was effectively absorbed by idle capacity while the aggregate query's saved work was the
only visible effect. Under the real 1-CPU Postgres limit, the rollup upsert competes for the
*same single core* as everything else -- the COPY transaction now holds its ingest connection
open longer (COPY + upsert, both against the one available core), directly explaining the
throughput drop; the rollup's own index maintenance (2.3M+ distinct bucket/service/level/shard
rows and growing) adds real WAL/B-tree work that crowds out the very CPU capacity the aggregate
query would need to benefit from a smaller scan. The two effects roughly cancel, and in this
measurement, the cost side wins outright.

Consistency check: the ~34-45% throughput cost seen here matches the isolated write-only
measurement at the same real-limits scale (12,048 logs/s over 320s without rollup vs 7,987
logs/s with, over the seeding runs that built each condition's dataset -- a ~34% gap, same
direction and similar magnitude as the combined-load figure above).

### Environment note

Docker Desktop's backing store went read-only partway through this round (`write ... meta.db:
read-only file system`, reproduced on two separate rebuild attempts) -- a host-level Docker
Desktop issue, not something fixable from this shell. This happened *after* the numbers above
were collected, so it does not affect their validity, but it did block restoring a final clean
container (the running container currently has a temporary `WCOST_DISABLE_ROLLUP` testing flag
baked in and lost its port mapping mid-rebuild). Source code is clean and verified independent of
this (`npm run typecheck`/`npm run build` both pass, no `WCOST_DISABLE_ROLLUP` references remain
in `src/` or `docker-compose.yml`) -- only the Docker image needs a fresh, successful
`docker compose up --build -d` once Docker Desktop is restarted, before this can be trusted for
an official submission.

### Recommendation

**Revert R1, not ship or lightly modify.** Under the real resource limits -- the only environment
that matters for scoring -- the rollup makes ingestion throughput measurably worse (~34-45%)
without the compensating aggregate-latency or Postgres-CPU benefit that justified building it;
at realistic scale under real limits, aggregate latency and Postgres CPU came out *worse*, not
better, with the rollup. The mechanism is understood (single-core contention between rollup
maintenance and everything else, not present on an unconstrained host), not just an
unexplained flip -- this is a confident recommendation, not a shrug. Reversing course from Round
8's "open question" framing is itself the point of this round: the environment that actually
determines the grade was unavailable then and is available now, and it gives a clear answer.

## Round 10 — Request-level ingestion coalescing, built and measured under real limits (2026-08-16)

Scope: with R1 (rollup) and R3 (trigram index) both ruled out under real Docker limits, moved to
a different lever targeting the same confirmed bottleneck (Postgres CPU pinned at 100-107% in
every official stage, independent of pool/timeout config): reduce the *number* of discrete
Postgres operations per accepted row, not the per-row cost. R1 first fully reverted in code (not
just recommended) so this round measures cleanly against the current baseline: `schema.ts`,
`logs.repository.ts`, `retention.repository.ts`/`.service.ts`/`.job.ts` all restored to their
pre-R1 state, migration `0002` deleted, native and Docker Postgres both had `logs_rollup` dropped
and the migration record removed. `npm test`: 42/42, matching the exact pre-R1 baseline count.

### What was built

`src/services/ingest-coalescer.ts` (`IngestCoalescer` class) sits between per-entry validation
(untouched) and the repository's `insertLogs`, in `logs.service.ts`. Concurrent `POST /logs`
requests arriving within a configurable window (`INGEST_COALESCE_WINDOW_MS`, default 15ms)
have their already-validated rows merged into one shared `COPY` instead of each request doing
its own. A safety valve (`INGEST_COALESCE_MAX_BATCH_ENTRIES`, default 10,000) flushes early if a
window accumulates too many rows, bounding worst-case latency and single-COPY size under
pathological concurrency.

**Correctness invariants, verified**:
- A request's promise resolves only after its rows are durably committed in the window's shared
  write -- never before.
- A window's failure rejects only the requests coalesced into that window; a later, independent
  window is unaffected (verified directly, not just by design intent -- see below).
- Per-entry validation and the accept/reject/index/reason contract are entirely upstream of the
  coalescer and untouched by it.

**Testing**: 6 new unit tests (merge-into-one-write, per-caller correct count vs. merged total,
resolve-only-after-durable-write, shared failure isolated to its own window, a later window
unaffected by an earlier failure, early-flush safety valve). A live differential test fired 200,
then 1,000 concurrent real HTTP requests, each with a deterministic mix of valid/invalid entries,
and checked the response contract plus DB durability directly: **0 contract failures, 0 missing
rows, 0 incorrectly-committed rejections** at both concurrency levels. Full suite (including the
6 new tests): 48/48, run both natively and via `docker compose --profile test run --rm test`
(the CI-equivalent path) under real limits -- clean.

### Performance, under real Docker limits (verified: `NanoCpus: 500000000`/`Memory: 268435456`
for app, `1000000000`/`1073741824` for postgres)

**Corrected composition alone (50.5 POST/s, batch=67, 25 `q=` probes/s, 1 official-shaped
aggregate/s), 90s: no meaningful difference**, matching the exact pattern Round 9 found for R1 --
this rate is too moderate to stress the real limits either way.

| Metric | Before (no coalescing) | After (coalescing, 15ms) |
|---|---:|---:|
| logs/s | 1,150.17 | 1,110.71 |
| Postgres CPU avg/max | 25.4% / 98.7% | 26.8% / 97.8% |

**Worker-scaled stage-shape pressure tests (the condition that actually reveals a difference,
per the same lesson learned from R1) -- clear win in every stage:**

| Stage (workers) | Before logs/s | After logs/s | Change |
|---|---:|---:|---:|
| Load (12) | 4,417 | 7,144 | +62% |
| Stress (24) | 3,675 | 8,932 | +143% |
| Spike (24) | 5,859 | 9,453 | +61% |
| Breakpoint (36), empty table | 5,690 | 10,977 | +93% |

Resource usage moved the same direction: Stress's App CPU avg/max dropped from 4.83%/21.43%
(before) to 0.69%/3.84% (after); Breakpoint's App CPU avg/max dropped from 2.79%/9.13% to
0.92%/5.33%. Coalescing reduces per-operation overhead throughout the request path, not only in
Postgres.

**Breakpoint at realistic scale (~2.8-3.7M rows, seeded over ~150-200s each) -- the condition
that actually matters for the official grade:**

| Metric | Before (~2.8M rows) | After (~3.7M rows) |
|---|---:|---:|
| logs/s | 3,648 | 5,105 (**+40%, despite more accumulated data**) |
| Postgres CPU avg/max | 4.82% / 20.53% | 2.01% / 7.19% |
| App CPU avg/max | 5.06% / 13.61% | 0.67% / 3.43% |
| Aggregate p50 | 168ms | 6ms |
| Aggregate p95/max | 1,290ms / 1,290ms | 2,124ms / 2,124ms (worse; n=16 each, plausibly noise -- reported honestly, not smoothed over) |

Pure write-only throughput (12 workers, no concurrent aggregate/RAW load) confirms the same
direction independently: 7,787-12,048 logs/s before (two separate earlier measurements) vs.
18,724-20,161 logs/s after (window 15ms/5ms) -- roughly 1.5-2.6x.

### Window-size tuning

| Window | 12-worker write-only logs/s | Breakpoint (36-worker) logs/s | Breakpoint PG CPU avg/max |
|---|---:|---:|---:|
| 5ms | 20,161 | 5,998 | 9.98% / 73.49% |
| 15ms (default) | 18,724 | 5,105 | 2.01% / 7.19% |
| 40ms | 12,609 (**regression**) | 5,959 | 2.26% / 13.88% |

40ms clearly regresses at low concurrency (12 workers) without a compensating win at high
concurrency -- with few concurrent requests, a longer window mostly adds pure wait latency rather
than catching more rows to merge. 5ms gives the highest raw throughput but noticeably more
Postgres CPU at Breakpoint pressure (max 73.49% vs. 7.19% for 15ms) -- closer to "many small
COPYs" behavior, so less of the per-operation-overhead benefit the whole change targets. **15ms
(the shipped default) has the lowest Postgres CPU footprint of the three at Breakpoint pressure
while still delivering the full throughput win over no coalescing at all** -- kept as the default
rather than re-tuned, since it directly targets the confirmed bottleneck (Postgres CPU) rather
than optimizing throughput in isolation.

### Verdict

**Keep it, ship it, default window unchanged (15ms).** Unlike R1, this result holds up under the
real resource limits that determine the grade -- verified directly, not assumed from an
unconstrained host. Every stage shape tested shows a real, substantial throughput improvement
(40-143% depending on pressure level) with lower Postgres and app CPU, at the realistic data
scale that matters (Breakpoint, ~2.8-3.7M rows). The one metric that did not improve (aggregate
p95/max at large scale) is reported plainly rather than hidden -- a small sample (n=16) and not
inconsistent with noise, but not claimed as a win either. Working tree only: no commit, no push,
per standing instruction, pending review.
