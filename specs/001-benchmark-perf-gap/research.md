# Phase 0 Research: Why the Official Benchmark Diverges From the Local Benchmark

**Feature**: [[spec.md]] | **Date**: 2026-08-13

> **Update 2026-08-13 (later same day)**: Phase 0 diagnostics have since been run against the live,
> resource-limited stack. See [[diagnostics.md]] for full results, a status update per root cause
> below, and a newly-identified, independently-confirmed contributor (index-only-scan → heap-fetch
> fallback under concurrent inserts) that this original research pass did not have. The labels below
> are left as originally written for the historical record; [[diagnostics.md]]'s "Updated status of
> research.md's root causes" table is the current source of truth.
>
> **Update 2026-08-13 (Phase B start)**: `official-benchmark-results.md` (same submission
> `7VQZVZDZZXEMTPTY36FM8S0R78`, confirmed by the user as the authoritative full read of the report —
> a fuller reading than the partial 3-stage summary used when this file was first written) is now the
> standing reference for all target-vs-achieved comparisons — see that file, not the abbreviated
> table in §1 below, for exact per-stage numbers. It adds a fourth stage (Spike) and shows the
> leaderboard rank moved #12→#15 (live leaderboard, other submissions moved it — not a data error).
> None of this changes the root-cause conclusions above: the defining signal (PostgreSQL CPU
> 70–107% vs. application CPU 5–20%) holds in all four stages per that file, so Root Causes #1–#5
> stand as diagnosed. It also surfaces a new data point this research pass didn't have: the report's
> own category breakdown scores "Queries" at only 6/15 — the weakest category — reinforcing Root
> Cause #2's aggregation-starves-behind-ingestion concern specifically, not just aggregate latency in
> general.

**Inputs**: repository audit (architecture/schema/ingestion/query/retention code read in full),
`context.md`, official benchmark report (submission `7VQZVZDZZXEMTPTY36FM8S0R78`, commit
`3416eb3b0ab0`), README's self-reported local benchmark (~33,185 logs/sec, treated here only as a
methodology data point, not as ground truth).

## 1. What the numbers say, side by side

| Metric | Local (README, self-reported) | Official — Load | Official — Stress | Official — Breakpoint |
|---|---:|---:|---:|---:|
| Target | — | 15,000/s × 120s | 15k→22.5k→30k/s | 15k→22.5k→30k→45k/s |
| Achieved logs/sec | 33,185.11 | 1,169.33 | 984.00 | 1,345.00 |
| Ingestion p95 | 696.94 ms | 5.08 s | 4.27 s | 5.00 s |
| Aggregate p95 | 997.37 ms | 5.79 s | 4.60 s | 5.99 s |
| Post success rate | (accepted=1,000,000, rejected=0) | 89.22% | 100% | 92.07% |
| HTTP error rate | not reported | 15.14% | 0% | 22.10% |
| Postgres CPU avg/max | ~90–97% (self-reported) | 82.09% / 107.09% | 74.34% / 100.02% | 70.59% / 100.14% |
| App CPU avg/max | ~40–49% (self-reported) | 5.04% / 20.08% | (not given) | (not given) |
| App memory max | ~65–69 MiB (self-reported) | 62.12 MiB | (not given) | (not given) |
| Correctness/reliability | — | 75/75, 20/20, 15/15, eventual consistency passed, 0 missing | same | same |

Two numbers matter more than any others here:

1. **Application CPU is nearly idle (5.04% avg, 20.08% max) while PostgreSQL is heavily loaded
   (82.09% avg, up to 107.09% max of its single core) in the official Load scenario.** The
   application is not doing meaningful work; it is waiting. This single pair of numbers rules out
   "the Node process is CPU-bound" as an explanation and points the entire investigation at
   PostgreSQL and at whatever sits between the app and PostgreSQL (the connection pool).
2. **Ingestion p95 (5.08 s / 4.27 s / 5.00 s) sits almost exactly at the pg `Pool`'s
   `connectionTimeoutMillis: 5000` configured in `src/db/index.ts`.** That is not a coincidence
   worth ignoring — it is the single strongest structural clue in this report.

## 2. Ranked root causes

Each cause below is labeled **CONFIRMED** (directly shown by the metrics/code with no missing link)
or **HYPOTHESIS** (consistent with the evidence, but requires a targeted measurement before being
treated as fact, per Constitution Principle VII).

### #1 — CONFIRMED: the application is not the bottleneck; PostgreSQL and/or the path to it is

- **Evidence**: App CPU 5.04% avg / 20.08% max vs. its 0.5-CPU budget; app memory 62 MiB vs. its
  256 MB budget — both nowhere near saturation. PostgreSQL CPU 70–82% avg and repeatedly hits
  100–107% (its full single-core budget) across all three scenarios.
- **Implication**: any fix aimed at Node-side CPU or memory (bigger app container, faster JSON
  parsing, worker threads) would not move the score. The investigation and the fix both belong on the
  PostgreSQL/connection side.

### #2 — HIGH-CONFIDENCE HYPOTHESIS: the 7-connection app-side pool with a 5 s connect timeout is
the proximate throughput ceiling and the direct cause of the elevated error rate

- **Evidence**: `src/db/index.ts` sets `max: 7` and `connectionTimeoutMillis: 5000`. `src/server/app.ts`
  explicitly catches `"timeout exceeded when trying to connect"` and similar pg-pool exhaustion
  messages and converts them to `503` — meaning this code path is a known, designed-for scenario, not
  a crash. Ingestion p95 landing at 5.08 s / 5.00 s (right at the 5000 ms ceiling) is the signature of
  requests queuing for one of 7 pooled connections and either just barely acquiring one before the
  timeout (inflating p95) or timing out into the 503 path (inflating the HTTP error rate: 15.14% in
  Load, 22.10% in Breakpoint). The one scenario with **0% error rate (Stress)** is also the one with
  the **lowest achieved throughput (984/s)** — consistent with lower realized concurrency against the
  same 7-connection ceiling producing queuing-but-not-timeout behavior, rather than the ceiling itself
  being higher there.
- **Why still a hypothesis, not confirmed**: we have not yet measured actual pool wait times or
  observed the exact rejected-request error bodies from a live run. The correlation is strong and the
  code path is real, but the missing link is a direct measurement (e.g., temporarily logging pool
  `waitingCount`/wait duration, or reproducing the same latency/error-rate shape locally under
  constrained resources) before treating "resize the pool" as guaranteed to help rather than shift the
  bottleneck one layer down.
- **Risk of over-correcting**: PostgreSQL is already CPU-saturated (#1). Simply raising `max` without
  measurement could let more concurrent COPY/query work reach an already-100%-CPU single core,
  worsening latency instead of improving it. This is exactly the kind of change Constitution
  Principle VII requires to be measured, not assumed.

### #3 — CONFIRMED (partially) / HYPOTHESIS (attribution): PostgreSQL's single CPU core is a hard,
already-saturated ceiling, but which workload is consuming it is not yet decomposed

- **Confirmed**: PostgreSQL CPU is at or above 100% of its single-core budget repeatedly in every
  scenario; PostgreSQL memory (515–569 MiB) stays comfortably under its 1 GB cap in all scenarios, so
  memory is not the constraint — this rules out `shared_buffers`/`work_mem` sizing as the primary
  cause (though `work_mem=32MB` under many concurrent aggregate queries is worth revisiting only if a
  future run shows memory pressure; it does not today).
  Every inserted row currently maintains three btree structures (the `(timestamp,id)` primary key plus
  two secondary composite indexes), and every aggregation query executes a `date_bin` group-by scan
  concurrently with that write traffic on the same single core.
- **Not yet confirmed**: how much of that CPU is COPY/WAL/index-maintenance from ingestion versus
  planning/execution cost from concurrently running aggregation queries versus contention/context-switch
  overhead from many small concurrent statements. This requires `EXPLAIN (ANALYZE, BUFFERS)` on the
  aggregation query under realistic concurrent load, and `pg_stat_statements` (or `pg_stat_activity`
  sampling) during a load run, before deciding whether the fix is "give ingestion and aggregation
  separate connection budgets," "reduce per-row index-maintenance cost," or "neither, the ceiling is
  simply the 1-CPU limit and the only lever is not competing with yourself for it."

### #4 — HYPOTHESIS: the official generator's concurrency/batching/pacing shape differs materially
from the local `scripts/load-test.ts` harness, and that difference — not just server-side capacity —
contributes to the gap

- **Evidence for**: the local harness uses a small, fixed concurrency of 6 workers issuing 2,500-row
  batches sequentially per worker (a closed-loop model: each worker only sends its next batch after the
  previous one resolves, so realized concurrency is capped at 6 in-flight requests, ever). The official
  contract in `context.md` only specifies target logs/sec and duration — it does not specify batch
  size, worker count, or open- vs. closed-loop pacing. An open-loop generator (keeps issuing requests
  at the target rate regardless of how fast the service is responding) against an undersized
  connection pool produces exactly the signature seen here: latency inflates toward the timeout
  ceiling and error rate rises as offered load exceeds what 7 pooled connections can drain, while the
  server never crashes and never loses accepted data (matching "0 missing records" and "eventual
  consistency: passed" in every scenario).
- **Why still a hypothesis**: we do not have the official generator's source or its exact batch
  size/concurrency, so this cannot be marked confirmed. It is testable, though: reproducing a
  high-concurrency, open-loop-style local harness against the same resource-limited
  `docker-compose.yml` and checking whether it reproduces a comparable latency/error-rate signature
  would confirm or reject this without spending an official re-submission.
- **Explicitly not the explanation on its own**: even if the official generator's concurrency shape
  differs, Root Cause #1 (app idle, Postgres saturated) means the *ceiling* the generator is running
  into is still a real server-side capacity limit, not merely a client-side artifact. Methodology
  differences explain why the local run didn't previously surface the problem; they do not by
  themselves explain the problem away.

### #5 — RULED OUT (by measurement): application-side memory/CPU exhaustion, JSON body size limits,
and PostgreSQL memory exhaustion

- App CPU/memory are both far under their caps in every metric given. `bodyLimit: 1_048_576` (1 MB) in
  `src/server/app.ts` is a fixed, generous ceiling unrelated to sustained throughput. PostgreSQL memory
  peaks at 569.30 MiB against a 1 GB cap — no evidence of swapping or memory pressure. These are
  recorded here specifically so they are not re-investigated later without new evidence contradicting
  this measurement.

### #6 — UNVERIFIED (missing data, not yet a cause or a non-cause): dataset-scale behavior at ~1M rows

- None of the three reported scenario summaries show accepted counts reaching 1,000,000 rows
  (175.4K / 98.4K / 161.4K). The "handle ~1,000,000 stored records" and "~1 month of data" targets in
  `context.md` may be exercised by a portion of the benchmark not included in the report excerpt
  provided, or may not yet be reached at the currently achieved ingestion rate within the scenario
  durations. This is flagged as an open question for the plan, not folded into the throughput root
  causes above, because we do not have direct evidence either way.

## 3. Impact ranking (for prioritizing the plan)

1. **#2 (pool/timeout ceiling)** — highest expected impact per unit of implementation effort; directly
   explains both the dominant latency signature and the error rate; change is small and reversible;
   but sizing it correctly requires measurement against #3, not a blind increase.
2. **#3 (Postgres CPU attribution)** — necessary to know *how big* a pool resize is safe, and whether
   any index/write-path change is justified at all; without this, #2 can only be tuned by trial and
   error against the official portal, which is slow and limited.
3. **#4 (methodology reproduction)** — not a server-side fix by itself, but the cheapest way to gain
   confidence in #2/#3 without spending an official re-submission on every iteration; should be done
   in parallel with #2/#3's diagnosis, before code changes ship.
4. **#6 (1M-row scale)** — lower immediate priority than the throughput/latency gap (which dominates
   the score), but must be checked before declaring the work done, since it is an explicit, separately
   graded requirement.

## 4. What must be measured before any code change ships

- Pool wait/queue telemetry (or equivalent temporary instrumentation) during a resource-limited local
  run, to confirm or reject Root Cause #2 directly rather than by latency-number correlation alone.
- `EXPLAIN (ANALYZE, BUFFERS)` on the aggregation query, executed while ingestion load is active
  against the resource-limited stack, to attribute PostgreSQL CPU cost (Root Cause #3).
- A local harness that can approximate higher, open-loop-style concurrency (Root Cause #4), run
  against the exact `docker-compose.yml` resource limits, to validate that a proposed pool/config
  change moves throughput/latency/error-rate in the right direction *before* it is spent on an official
  re-submission.

These measurements are the first phase of [[plan.md]] and precede any change to `pool.max`,
`connectionTimeoutMillis`, index layout, or query structure.
