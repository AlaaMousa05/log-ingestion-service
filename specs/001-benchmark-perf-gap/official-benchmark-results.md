# Official Benchmark Results — Ground Truth Reference

**Source**: https://loadgen.foothilltech.net/submission/7VQZVZDZZXEMTPTY36FM8S0R78
**Date recorded**: 2026-08-13
**Status**: Read directly from the official grading run. This file is the source of truth for
"did we actually close the gap" — every future change must be checked against these numbers,
not just against local load-test.ts output (see the methodology caveat at the bottom).

## Commit ↔ submission mapping (authoritative — do not confuse these)

| Submission file | Commit SHA | Score | Rank | Notes |
|---|---|---|---|---|
| `test1.pdf` | `3416eb3b0ab092bf7aed2456462804e2ba1028cf` | 59.40/100 | #15 | Original baseline, before any of the pool/timeout work in this doc. |
| `test2.pdf` | `7e217a3160ca12e3860d1c4a675c7541e60fab68` | 45.51/100 | #49 | After the pool-split + query-timeout-to-2500ms change — this is the regression analyzed below and in `diagnostics.md`. |
| `test3.pdf` | `44358f2da68666d8dffed69508583edf09d46631` | 59.49/100 | #24 | Phase 0 fix: query pool timeout restored 2500ms→8000ms. Amended from `9307209` (same content, Co-Authored-By trailer removed) and force-pushed to `main`. Performance recovered to 18.49/50 (test1: 18.40/50, test2: 4.51/50) — Reliability/Correctness/Queries unchanged from test1/test2. Full 3-way comparison and metric-to-diff causal analysis in `diagnostics.md` Round 6. |
| *(not yet submitted)* | working tree, based on `44358f2` | — | — | Request-level ingestion coalescing (`POST /logs` merges concurrent requests' validated rows into one shared `COPY` per ~15ms window instead of one `COPY` per request), targeting the Postgres-CPU-pinned-at-100–107% bottleneck confirmed in every stage of test1/test2/test3 alike. Two other candidates were built and measured first: an incremental rollup table for `GET /logs/aggregate` (net negative under real 0.5/1 CPU limits despite a large win on an unconstrained host — reverted) and a GIN/trigram index on `message` (write-side cost with the index never used by the planner at tested scale — reverted). Neither survived real-limits measurement; coalescing did. Local A/B under this repo's own real resource limits (0.5 CPU/256MB app, 1 CPU/1GB Postgres, `docker inspect`-verified): +40–143% throughput across all four stage shapes depending on pressure level, Postgres/app CPU both down at realistic scale (~2.8–3.7M rows), aggregate p50 down; aggregate p95/max at that same large scale was the one metric that got worse (small sample, reported as such, not hidden). Full numbers, the two reverted candidates' own diagnosis, and the window-size tuning in `diagnostics.md` Rounds 7–10. Call its result `test4.pdf` once obtained, and add its row here — treat that result as authoritative over this local measurement, same as every round before it. |

The full test1 vs. test2 metric comparison and root-cause diagnosis lives in
`diagnostics.md` and the published regression-analysis artifact — this table exists so no
future session confuses which commit produced which score.

> **Standing instruction: consult this file before proposing any change, and re-check the
> relevant rows after every change that's meant to affect performance.** Do not rely solely on
> local `scripts/load-test.ts` runs to judge success — the official generator's concurrency/
> batching/network methodology is not fully known to us (see caveat below), so local numbers are
> a proxy, not proof.

## Overall score

**59.40 / 100** — Rank #15

| Category | Score |
|---|---|
| Performance | 18.40 / 50.00 |
| Reliability | 20.00 / 20.00 |
| Correctness | 15.00 / 15.00 |
| Queries | 6.00 / 15.00 |

Performance and Queries are the two weak categories — biggest room for improvement.

## Per-stage results

| Stage | Pattern | Duration | Logs/sec (rate) | Error rate | App CPU max/avg | Postgres CPU max/avg | Latency (p95) mult. | Ingestion lat. mult. | Aggregate P95 mult. |
|---|---|---|---|---|---|---|---|---|---|
| **Load** | flat 15,000 logs / 120s | 2.00 min | 2,549.17 | 0.00% | 19.55% / 5.78% | 105.55% / 73.52% | — | 3.64x | 4.08x |
| **Stress** | 15,000/30s → 22,500/60s → 30,000/60s | 2.50 min | **1,169.13** | **15.14%** | 20.08% / 5.04% | 107.09% / 82.09% | 5.51x | 5.08x | 5.79x |
| **Spike** | 7,500/30s → 30,000/10s spike → 7,500/60s | 3.67 min | 584.00 | 0.00% | 8.69% / 3.02% | 100.02% / 74.34% | 4.34x | 4.27x | 4.60x |
| **Breakpoint** | 15,000/30s → 22,500/30s → 30,000/30s → 45,000/30s | 2.00 min | 1,345.00 | **22.10%** | 7.95% / 3.13% | 100.14% / 70.59% | 5.40x | 5.00x | 5.99x |

Key pattern across **every** stage: Postgres CPU sits at 70–107% (single core saturated) while
app CPU never exceeds ~20% (usually single digits). This is a direct read of the official
numbers, not an inference — it's the strongest evidence that the bottleneck is
PostgreSQL-side contention, not application compute.

## Eventual consistency (read-after-write)

| Stage | Accepted | Visible | Missing | Read-after-write success | Drain multiplier |
|---|---|---|---|---|---|
| Load | 305.9K | 305.9K | 0 | — | 3.28x |
| Stress | 175.4K | 175.4K | 0 | **0.06%** | 1.91x |
| Spike | 98.4K | 98.4K | 0 | — | 1.03x |
| Breakpoint | 161.4K | 161.4K | 0 | — | 1.67x |

No data was ever lost (Missing = 0 in every stage), but during Stress, an immediate read right
after a write almost never saw the just-written row (0.06% success) — consistent with pipeline/
visibility lag under load, separate from (but related to) the aggregate-latency problem.

## Target vs. achieved (from context.md's performance targets)

| Target | Required | Achieved (worst official stage) |
|---|---|---|
| Sustained throughput | 15,000 logs/sec | 584–2,549 logs/sec depending on stage |
| Aggregate p95 | < 1 second | 4.08x–5.99x over target (i.e. several seconds) |
| Dropped requests | 0 | up to 22.10% error rate (Breakpoint stage) |
| Queryable within | 20 seconds | drain multiplier up to 3.28x over some implicit baseline |

## Methodology caveat (still open, do not treat as resolved)

We do **not** have access to the official load generator's actual script/config — only its
final numbers. Locally, `scripts/load-test.ts` pushed 6→128 workers and got closest to the
official aggregate-latency magnitude at 64 workers with a concurrent EXPLAIN probe (4.22s vs.
official 4.60–5.99s), but **never reproduced the official error rate** (0% locally at every
worker count tested, vs. 15–22% officially). This suggests the official generator may use
higher effective concurrency, different batching, and/or real network latency that the local
harness doesn't capture. Any locally-measured "fix" should be treated as evidence a mechanism
is real, not as proof it fully explains the official numbers, until a new official submission
confirms it.
