# Implementation Plan: Close the Official Benchmark Performance Gap

**Branch**: `001-benchmark-perf-gap` (directory only, no git branch/commit yet) | **Date**: 2026-08-13 | **Spec**: [[spec.md]]

**Input**: [[spec.md]], [[research.md]], `context.md`, official benchmark submission
`7VQZVZDZZXEMTPTY36FM8S0R78` (commit `3416eb3b0ab0`)

**Status**: Planning only. No implementation, commits, branches, or pushes happen until this plan is
explicitly approved.

## Summary

The service passes essentially every correctness/reliability check the official benchmark runs, but
achieves only ~8–9% of the target ingestion throughput and 4.6–6.0× the target aggregation latency.
[[research.md]] shows the application container is nearly idle (5% CPU) while PostgreSQL is at or
above its single-core budget, and that ingestion p95 latency lands almost exactly on the app's
5-second pool connection timeout — pointing at the database connection pool and PostgreSQL's CPU
budget as the primary suspects, with the local load-test harness's low, closed-loop concurrency as a
likely reason this was never seen locally. This plan is a **diagnose-then-fix** plan: it instruments
and measures before changing any behavior, then proposes the smallest change per confirmed root
cause, verified first locally and then against the official benchmark portal, one change at a time so
that score movement is attributable.

## Technical Context

**Language/Version**: TypeScript 5.9 (Node.js 22, ESM), compiled via `tsc`

**Primary Dependencies**: Fastify 5, Drizzle ORM 0.45 (`drizzle-orm/node-postgres`), `pg` 8 (node-postgres),
`pg-copy-streams` 7

**Storage**: PostgreSQL 18.4, single instance, PostgreSQL is and remains the sole source of truth
(Constitution Principle II) — no new storage technology is in scope for this plan

**Testing**: Vitest 4 (unit: validator/service; integration: repository against a real DB, full HTTP
contract via `app.inject`), plus `scripts/audit-run.sh` (black-box smoke test against a running
container) and `scripts/load-test.ts` (throughput/latency harness)

**Target Platform**: Linux containers via `docker compose up`, app + PostgreSQL 18.4

**Project Type**: Single backend service (Fastify HTTP API + PostgreSQL)

**Performance Goals**: from `context.md` — ≥15,000 logs/sec sustained (up to 45,000 logs/sec at
breakpoint), `GET /logs/aggregate` p95 < 1 s while ingestion is active, ~1,000,000 stored rows
(~1 month of data), newly ingested data queryable within 20 s, 1 aggregation request/sec sustained
during ingestion

**Constraints**: application container 0.5 CPU / 256 MB RAM; PostgreSQL container 1 CPU / 1 GB RAM
(both already enforced correctly via `cpus:`/`mem_limit:` in `docker-compose.yml`, confirmed in the
prior audit); required API contract (`GET /health`, `POST /logs`, `GET /logs`, `GET /logs/aggregate`)
must not change shape; no auth/rate limiting is implemented today and none is introduced by this plan

**Scale/Scope**: this plan is scoped to closing the throughput/latency gap shown in the official
benchmark; it explicitly excludes new features, schema redesign, or optional-feature work (auth,
dashboards, etc.) — see Non-Goals below

## Constitution Check

*Gate against `.specify/memory/constitution.md`, checked before Phase 0 and re-checked after Phase 1.*

| Principle | Check | Result |
|---|---|---|
| I. Contract Fidelity & Additive Extensions | All proposed changes (pool sizing, instrumentation, possible index/query tuning) touch only internal implementation, not request/response shapes or endpoint paths | ✅ Pass |
| II. PostgreSQL as Source of Truth | No new storage layer proposed; COPY-based durable writes remain unchanged in semantics | ✅ Pass |
| III. Parameterized Queries & Validated Ingestion | No proposed change touches query-string construction or validation logic | ✅ Pass |
| IV. Resource-Bounded Performance | Every proposed change is explicitly evaluated against the 0.5 CPU/256 MB and 1 CPU/1 GB limits, not against unconstrained hardware | ✅ Pass (by design of this plan) |
| V. Retention Without Disruption | Retention code path is untouched by every proposed change | ✅ Pass |
| VI. Test-Backed Change | Every proposed change lists its test strategy below; none weakens an existing assertion | ✅ Pass (enforced by Change Workflow) |
| VII. Evidence-Based Optimization | Diagnostics (Phase A) precede fixes (Phase B); hypotheses are labeled as such in [[research.md]] and not implemented until confirmed | ✅ Pass (this is the organizing principle of the whole plan) |

No violations requiring a Complexity Tracking entry.

## Project Structure

### Documentation (this feature)

```text
specs/001-benchmark-perf-gap/
├── spec.md              # Requirement mapping + gap identification (done)
├── research.md           # Phase 0 — ranked, evidence-labeled root causes (done)
├── plan.md               # This file — Phase 1 diagnostic + remediation plan
└── quickstart.md          # Baseline → change → test → benchmark runbook
```

`data-model.md` and `contracts/` are intentionally omitted: this feature changes no domain entities
and no request/response contracts (Constitution Principle I) — only internal performance-affecting
configuration and, conditionally, index/query internals. `tasks.md` is intentionally not produced by
this command; it is generated only after this plan is approved, by a separate `/speckit-tasks` step.

### Source code affected (repository root, no new top-level structure)

```text
src/
├── db/index.ts                      # pg Pool configuration — primary candidate for change B1
├── server/app.ts                    # pool-exhaustion → 503 handling — read, possibly extended for telemetry
├── repositories/logs.repository.ts  # insertLogs / findLogs / aggregateLogs — read for EXPLAIN diagnostics; conditionally touched by B2
├── db/schema.ts                     # index definitions — conditionally touched by B2, gated on A2 findings
└── db/migrations/                    # any index/config change ships as a new migration, per existing convention

scripts/
├── load-test.ts                     # extended for A3 (higher-concurrency/open-loop reproduction)
└── audit-run.sh                     # unchanged; remains the correctness regression gate

tests/
└── (existing suite)                 # unchanged in assertions; new tests added only if B-phase changes introduce new observable behavior (e.g., pool-separation)
```

**Structure Decision**: no new modules, services, or directories. This is a targeted, single-project
change set confined to connection/config handling and (conditionally) index/query internals — matching
Constitution Principle VII's "smallest independently-verifiable increment" and the user's explicit
"avoid unnecessary refactoring" instruction.

## Phase 0: Diagnostics (must run before any Phase B change)

Full detail in [[research.md]] §4. Summarized here as gated work items:

| ID | Diagnostic | Confirms/Refutes | Output |
|---|---|---|---|
| A1 | Add temporary pool-wait telemetry (log `pool.waitingCount`/`pool.totalCount` or wait duration at request boundaries) during a local resource-limited load run | Root Cause #2 (pool ceiling) | Confirmed/refuted pool-wait numbers correlated with observed latency |
| A2 | `EXPLAIN (ANALYZE, BUFFERS)` on the aggregation query + `pg_stat_statements` (or `pg_stat_activity` sampling) during concurrent ingestion, under the resource-limited stack | Root Cause #3 (Postgres CPU attribution) | Cost breakdown: COPY/index-maintenance vs. aggregation query execution vs. contention |
| A3 | Extend `scripts/load-test.ts` (or add a sibling script) to issue requests at higher realized concurrency, open-loop style, against the exact `docker-compose.yml` limits | Root Cause #4 (methodology gap) | Whether local reproduction shows the same latency/error-rate signature as the official report |

Each diagnostic is additive (new script/flag or temporary log fields), reversible, and requires no
official benchmark re-submission — they are validated purely with local tooling and are removed or
gated behind a debug flag before final submission if they add any request-path overhead.

**Acceptance criteria (Phase 0)**:
- A1: pool wait metric is visible in logs during a local load run reproducing ≥7 concurrent
  in-flight `POST /logs` requests, and either shows queuing/timeouts correlating with elevated
  latency (confirms #2) or does not (refutes #2, redirect investigation).
- A2: `EXPLAIN (ANALYZE, BUFFERS)` output and statement statistics are captured and attribute
  PostgreSQL CPU time across COPY/index maintenance vs. aggregation query execution to within a
  reasonable order of magnitude (not necessarily exact).
- A3: the extended local harness, run under identical container limits, produces a throughput/
  latency/error-rate profile that is compared explicitly against the official numbers in this plan's
  tables — close alignment increases confidence that local iteration is predictive; a large mismatch
  is itself a finding, reported rather than hidden.

**Test strategy (Phase 0)**: none of A1–A3 change production behavior in a way existing tests assert
against; `npm test` and `scripts/audit-run.sh` must still pass unmodified with any temporary
instrumentation in place. If A1's telemetry is left in the codebase, it must be behind a level check
(e.g., only emitted at `debug`/`trace` log level) so it does not affect default `LOG_LEVEL=warn`
behavior or performance.

**Benchmark verification (Phase 0)**: none — Phase 0 produces no official re-submission by itself; it
produces the evidence Phase B changes are justified by.

## Phase B: Candidate Changes (each gated on Phase 0 findings; implement and verify one at a time)

> None of these are committed to unconditionally. Each is gated on its stated Phase 0 evidence and is
> only implemented if that evidence confirms the root cause it addresses — per Constitution
> Principle VII and the user's explicit instruction to avoid speculative optimization.

### B1 — Right-size (or split) the database connection pool

- **Gated on**: A1 confirming pool queuing/timeouts as a real, measured constraint, and A2 showing
  how much PostgreSQL CPU headroom (if any) exists to safely serve more concurrent connections.
- **Candidate shape** (final numbers set by A1/A2 measurement, not guessed here): raise `pool.max` in
  `src/db/index.ts` to a value A1/A2 show PostgreSQL can actually service without pushing sustained
  CPU past its 1-core ceiling; and/or lower `connectionTimeoutMillis` so a saturated pool sheds load
  via the existing 503 path faster instead of accumulating multi-second latency; and/or introduce a
  second, small dedicated pool (or reserved headroom) for `GET /logs/aggregate` and `GET /health` so
  a burst of ingestion COPY calls cannot starve the required 1-req/sec aggregation traffic — this
  specific sub-option is only pursued if A1 shows aggregation requests specifically queuing behind
  ingestion requests on a shared pool, not just pool exhaustion in general.
- **Acceptance criteria**:
  - Local load test (resource-limited `docker-compose.yml`) shows ingestion p95 latency drop
    materially from the pre-change baseline captured in Phase 0, with no increase in dropped/failed
    requests beyond the existing designed-503-shedding behavior.
  - Local load test shows aggregation p95 drop materially from baseline while ingestion is
    concurrently active.
  - PostgreSQL container CPU/memory stay within their 1 CPU / 1 GB limits throughout (no new
    resource-limit violations introduced).
  - `npm test` and `scripts/audit-run.sh` pass unchanged.
- **Test strategy**: existing Vitest integration suite (`tests/api.integration.test.ts`,
  `tests/logs.repository.test.ts`) run unmodified — pool sizing is not asserted on directly, so a
  regression here would surface as a timeout/flake, which is itself a meaningful signal. If the pool
  is split (ingestion vs. query), add one targeted integration test asserting `GET /logs/aggregate`
  still responds successfully while a batch of concurrent `POST /logs` requests are in flight,
  simulating the "maintain query performance while ingestion is active" requirement directly rather
  than only relying on external load-test observation.
- **Benchmark verification**: re-run the local extended harness (A3) first; only submit to the
  official portal once local numbers show clear directional improvement under the same resource
  limits. Compare the new official report's Load/Stress/Breakpoint throughput, ingestion p95,
  aggregate p95, and HTTP error rate directly against the `7VQZVZDZZXEMTPTY36FM8S0R78` baseline table
  in [[research.md]] §1.
- **Confidence/Risk**: high expected impact if A1 confirms; low implementation risk (a handful of
  config values, fully reversible); the main risk is mis-sizing against PostgreSQL's CPU ceiling,
  which is exactly why A2's measurement gates the specific numbers chosen.

### B2 — Narrow index/query adjustment on the write or aggregation path (conditional, likely deferred)

- **Gated on**: A2 specifically attributing meaningful PostgreSQL CPU cost to index maintenance on the
  hot insert path, or to avoidable cost in the aggregation query plan (e.g., an unexpected sequential
  scan, sort, or hashing cost not explained by data volume alone).
- **Candidate shape**: not prescribed here. Per Constitution Principle VII and the user's "avoid
  speculative optimization" instruction, this plan deliberately does not propose adding, removing, or
  restructuring an index or query without a specific `EXPLAIN (ANALYZE, BUFFERS)` finding from A2
  naming the cost. If A2 does not surface a clear, attributable cost here, B2 is not implemented at
  all — B1 and A3's confirmation of methodology are treated as sufficient.
- **Acceptance criteria (if pursued)**: the specific `EXPLAIN (ANALYZE, BUFFERS)` cost A2 identified is
  measurably reduced post-change, on the same query/data shape, without changing any query's returned
  rows, ordering, or count (verified against the existing repository/integration tests, which assert
  exact result sets for filters, ordering, and aggregation counts).
- **Test strategy (if pursued)**: `tests/logs.repository.test.ts` and the aggregation portion of
  `tests/api.integration.test.ts` must pass unmodified — these already assert exact filter/ordering/
  count behavior, so they are sufficient regression coverage for a plan-internal change that must not
  alter query semantics.
- **Benchmark verification (if pursued)**: same protocol as B1 — local A3 harness first, then official
  re-submission, compared against the most recent prior official report (B1's post-change report if
  B1 shipped first), not against the original `7VQZVZDZZXEMTPTY36FM8S0R78` baseline, so the
  attribution stays specific to B2's own effect.
- **Confidence/Risk**: unknown impact until A2 completes (could be zero, could be significant);
  implementation risk is low-to-moderate depending on what A2 finds (e.g., dropping an index is
  low-risk/high-reversibility; changing the aggregation query's shape carries more regression surface
  and leans more heavily on the existing test suite).

### B3 — Upgrade the local reproduction harness itself (verification tooling, not a server-side fix)

- **Gated on**: A3's own findings — if the extended harness already reproduces a comparable signature
  to the official report, B3 is really just "keep A3's harness as a permanent script"; if it does not,
  B3 becomes "iterate on the harness's concurrency/pacing model until it does," since an unrepresentative
  local harness undermines every other change's local verification step.
- **Acceptance criteria**: the harness, run under the exact `docker-compose.yml` resource limits,
  produces throughput/latency/error-rate numbers that move in the same direction, and in comparable
  proportion, to what an official re-submission subsequently confirms — validated retrospectively
  after the first B1 (and, if applicable, B2) official re-submission.
- **Test strategy**: this is test/verification infrastructure, not production code — no Vitest
  coverage needed; its own correctness is validated by comparing its output to the official benchmark
  report after each real re-submission.
- **Benchmark verification**: N/A directly (this change *is* part of the benchmark-verification
  strategy) — see the Baseline → Change → Test → Benchmark loop below.
- **Confidence/Risk**: low risk (test tooling only, never shipped to the app container); high value
  for every subsequent change's ability to iterate without spending official re-submissions.

## Non-Goals (explicitly out of scope for this plan)

- No new indexes, GIN/trigram search, or attribute-storage redesign unless B2 is triggered by a
  specific A2 finding — the dual `attributes`/`attributes_text` JSONB design and existing composite
  indexes are not being second-guessed speculatively.
- No auth, rate limiting, multi-tenancy, or other optional features from `context.md`'s stretch-goal
  list — unrelated to the benchmark score gap.
- No README rewrite as part of this plan's implementation phase — FR-013 in [[spec.md]] is
  acknowledged but tracked separately; README accuracy does not affect the load-generator's measured
  score.
- No change to validation rules, response shapes, cursor format, or retention batching logic — all
  confirmed passing today (75/75 correctness, 20/20 reliability) and explicitly protected by
  Constitution Principle VI.
- No general-purpose refactor of `logs.repository.ts` or `logs.controller.ts` beyond what a confirmed
  root cause specifically requires.

## Prioritization (impact × confidence × risk)

| Priority | Item | Expected impact | Confidence it addresses the real cause | Implementation risk |
|---|---|---|---|---|
| 1 | A1 + A2 + A3 (diagnostics) | N/A directly — but unlocks everything below with evidence instead of guesswork | — | Very low (additive, reversible, no behavior change) |
| 2 | B1 (pool sizing/splitting) | High — directly targets the strongest, most specific signal in the report (p95 ≈ timeout ceiling, app idle/Postgres saturated) | High, pending A1/A2 confirmation | Low (config-level, fully reversible) |
| 3 | B3 (harness upgrade) | Indirect — makes every future iteration faster and official-submission-frugal | High (self-validating against real re-submissions) | Very low |
| 4 | B2 (index/query tuning) | Unknown until A2 completes; potentially zero | Unknown — explicitly conditional | Low–moderate depending on finding |

This ordering follows the user's requirement to prioritize by expected impact, confidence, and risk:
diagnostics come first because every downstream item's confidence rating depends on them; B1 is
prioritized over B2 because it is backed by the single strongest piece of evidence in the report
(the timeout-aligned p95) while B2 has no specific evidence yet; B3 runs alongside B1 so that B1's
local verification is trustworthy before spending an official re-submission on it.

## Baseline → Change → Test → Benchmark Comparison Strategy

Full step-by-step runbook in [[quickstart.md]]. Summary of the loop, repeated per change:

1. **Baseline**: the official report for commit `3416eb3b0ab0` (this document's tables) is the fixed
   reference point for the *first* change. For every change after the first, the baseline becomes the
   most recent prior official report, so each change's attributed effect is isolated.
2. **Change**: implement exactly one gated item from Phase B (never bundle B1 and B2 into one
   submission — Constitution Principle VII / Change Workflow step 5).
3. **Test**: run `npm run typecheck && npm run build && npm test` and `scripts/audit-run.sh` against
   the changed code — all must pass unmodified in their assertions (Scenario 3 in [[spec.md]]).
4. **Local benchmark**: run the (by then upgraded, per B3) local harness against the exact
   `docker-compose.yml` resource limits and record throughput, ingestion p95, aggregate p95, error
   rate, and container CPU/memory — compare directly against the pre-change local run. Only proceed
   to step 5 if this shows improvement or, at minimum, no regression.
5. **Official benchmark**: submit to `https://loadgen.foothilltech.net/` and record the new report's
   score, rank, and full metric table.
6. **Compare & decide**: place the new report side-by-side with the previous one (same table shape as
   [[research.md]] §1). If the targeted metric(s) improved and correctness/reliability held at their
   current maximums, keep the change and proceed to the next Phase B item. If not, revert the change,
   return to Phase 0 diagnostics with the new data point, and re-plan before trying again — never stack
   an unverified change on top of another.
7. **Record**: append each iteration's before/after table to this plan (or a dated log alongside it)
   so the full chain of evidence from 59.40/100 forward is auditable.

## Complexity Tracking

*No entries — no Constitution Check violations were identified.*
