# Feature Specification: Close the Official Benchmark Performance Gap

**Feature Branch**: `001-benchmark-perf-gap` (directory only — no git branch created; planning phase)

**Created**: 2026-08-13

**Status**: Draft — awaiting approval before any implementation

**Input**: Repository audit (this conversation) + `context.md` (authoritative spec) + official
benchmark report (submission `7VQZVZDZZXEMTPTY36FM8S0R78`, commit `3416eb3b0ab0`, score 59.40/100,
rank #12)

## Why This Feature Exists

The service already passes every functional/correctness check the official benchmark runs
(75/75 correctness checks, 20/20 reliability, 15/15 correctness, 0 missing records, eventual
consistency passed). It fails almost entirely on **throughput and latency under the official load
generator**, achieving 1,169–1,345 logs/sec against a 15,000 logs/sec baseline target, and
4.6–6.0 s aggregation p95 against a 1 s target — despite an unrelated local benchmark reporting
~33,000 logs/sec. This gap is large enough, and surprising enough given the local numbers, that it
must be treated as its own investigation before any code changes are made.

## Stakeholder Scenarios & Testing *(mandatory)*

### Scenario 1 - Official Load Generator Sustains Target Ingestion Rate (Priority: P1)

The official, uncustomized load generator sends structured log batches to `POST /logs` at up to
15,000 logs/sec (baseline) and up to 45,000 logs/sec (breakpoint) for the durations specified in
`context.md`, and the service accepts them durably without crashing, without unbounded latency
growth, and without an elevated HTTP error rate.

**Why this priority**: this is the primary axis the score (59.40/100) is currently failing on; every
other requirement in this spec is secondary to closing this gap.

**Independent Test**: resubmit the same commit (unchanged) to `https://loadgen.foothilltech.net/` and
compare `Achieved logs/sec`, `HTTP error rate`, and `Post success rate` against the current run.
Independently, reproduce a comparable concurrency/latency signature locally against the same
container resource limits, without needing the official portal, once the local harness is extended
to resemble the official load shape (see [[research.md]]).

**Acceptance Scenarios**:

1. **Given** the official load generator issuing the baseline scenario (15,000 logs/sec for 120 s),
   **When** the run completes, **Then** achieved throughput is materially closer to 15,000 logs/sec
   than the current 1,169.33 logs/sec, and the HTTP error rate is materially lower than the current
   15.14%.
2. **Given** the official load generator issuing the stress scenario (15,000 → 22,500 → 30,000
   logs/sec ramps), **When** the run completes, **Then** `Post success rate` remains at or above the
   current 100% and `Rejected`/`Missing records` remain 0.
3. **Given** the official load generator issuing the breakpoint scenario (ramping to 45,000
   logs/sec), **When** the service reaches its real ceiling, **Then** it sheds load with 503/429 and
   `Retry-After` rather than crashing or silently dropping accepted-looking requests, matching current
   correct behavior at the ceiling that already exists today.

---

### Scenario 2 - Aggregation Stays Fast While Ingestion Is Active (Priority: P1)

An operator (or the load generator, which issues ~1 aggregation request/sec throughout every
scenario) queries `GET /logs/aggregate` while ingestion is running at load, and receives a response
inside the target latency, not degraded by concurrent write traffic.

**Why this priority**: tied for highest priority with Scenario 1 — "maintain query performance while
ingestion is active" is graded independently of raw ingestion throughput, and the current p95
(4.60–5.99 s across all three scenarios) misses the 1 s target by 4.6–6×, consistently, in every
scenario measured.

**Independent Test**: run the local load test with `aggregateDuringIngestion` active (already built
into `scripts/load-test.ts`) against the resource-limited `docker-compose.yml` stack, and read
`aggregation_latency.p95_ms` from the summary; confirm the number moves in the same direction as the
official benchmark's `Aggregate p95` after any change.

**Acceptance Scenarios**:

1. **Given** ingestion sustained at whatever rate the service can durably accept, **When** an
   aggregation request is issued, **Then** its p95 latency is materially closer to 1 s than the
   current 4.60–5.99 s range.
2. **Given** the aggregation query result, **When** compared against the pre-change result for the
   same filter/time-range/bucket combination, **Then** the returned buckets and counts are identical
   — only latency changes, never correctness.

---

### Scenario 3 - No Regression to Passing Requirements (Priority: P1)

Every requirement the benchmark currently scores at maximum (correctness 15/15, reliability 20/20,
eventual consistency, 0 missing records, 0 rejected-when-valid) continues to pass after any change
made to close the throughput/latency gap.

**Why this priority**: equal priority to Scenarios 1–2 by design — a change that trades correctness
or reliability points for throughput points is a net loss and violates Constitution Principle VI
(Test-Backed Change). This is the guardrail scenario for the whole effort.

**Independent Test**: `npm test` (Vitest unit + integration suite) and `scripts/audit-run.sh` both
pass, unmodified in their assertions, after every proposed change; the official benchmark's
correctness/reliability/eventual-consistency figures do not drop below their current values on
re-submission.

**Acceptance Scenarios**:

1. **Given** the full Vitest suite (validator, service, repository, retention, HTTP integration),
   **When** run after a proposed change, **Then** all tests pass with no assertions weakened or
   removed to accommodate the change.
2. **Given** the required API contract (`GET /health`, `POST /logs`, `GET /logs`,
   `GET /logs/aggregate`), **When** inspected after a proposed change, **Then** paths, methods, and
   response shapes are byte-for-byte unchanged from `context.md`.
3. **Given** a benchmark re-submission after a change, **When** the report is read, **Then**
   `Correctness checks`, `Reliability score`, `Correctness score`, `Eventual consistency`, and
   `Missing records` are unchanged or improved — never worse than 75/75, 20/20, 15/15, passed, 0.

---

### Edge Cases

- What happens when the connection pool is resized and Postgres's own `max_connections` or
  available CPU becomes the new limiting factor instead of the app-side pool? (Must be observed via
  metrics, not assumed away — see [[research.md]] Root Cause #3.)
- How does the service behave if the official generator's concurrency is high enough that even a
  correctly-sized pool saturates Postgres's single CPU core? (Expected: graceful 503 shedding, not
  timeouts that silently inflate latency — this is itself measurable and testable.)
- What happens to retention and health-check queries if they now compete with ingestion for a
  differently-sized pool? (Must not regress `/health`'s ability to report ready quickly.)
- What happens if a proposed change (e.g., pool resize) helps the baseline scenario but hurts the
  breakpoint scenario, or vice versa? (All three official scenarios must be checked, not just one.)

## Requirements *(mandatory)*

### Functional Requirements — mapped from `context.md` to current implementation status

| # | Requirement (context.md) | Current implementation | Status |
|---|---|---|---|
| FR-001 | `GET /health` returns 200 only once DB is connected, migrations applied, and service is ready | `src/index.ts` runs `SELECT 1` → `migrate()` → `app.listen()` in that order; `/health` route itself checks DB reachability | ✅ Met |
| FR-002 | `POST /logs` validates per-entry, accepts partial batches, returns index+reason for rejects, 200/400 per the documented rules | `log.validator.ts`, `logs.service.ts`, `logs.controller.ts` | ✅ Met (75/75 correctness checks, confirms this) |
| FR-003 | `GET /logs` supports all documented filters, cursor pagination, deterministic descending sort | `logs.repository.ts::findLogs`, composite `(timestamp,id)` PK backs the sort/cursor | ✅ Met |
| FR-004 | `GET /logs/aggregate` supports bucketing, `group_by`, ordering, empty-bucket omission | `logs.repository.ts::aggregateLogs` | ✅ Met functionally, ❌ **fails its own latency target** (see FR-007) |
| FR-005 | Optional features (auth, rate limiting, tenancy) must default off and never break the core contract | None implemented | ✅ Trivially met (nothing to misconfigure) |
| FR-006 | `docker compose up` starts the complete system unattended, with real resource limits enforced | `docker-compose.yml` uses `cpus:`/`mem_limit:` (correctly enforced outside Swarm, unlike `deploy.resources.limits`) | ✅ Met |
| FR-007 | Sustain ≥15,000 logs/sec; avoid dropped requests/crashes during sustained ingestion | Official benchmark: 1,169–1,345 logs/sec achieved; 0 crashes; but 15.14–22.10% HTTP error rate in two of three scenarios | ❌ **Failing** (throughput ~8–9% of target; error rate is real request shedding, not silent loss) |
| FR-008 | `GET /logs/aggregate` p95 < 1 s, and query performance must hold while ingestion is active | Official benchmark: 4.60–5.99 s p95 across all three scenarios | ❌ **Failing**, consistently, in every scenario |
| FR-009 | Newly ingested data queryable within 20 s (eventual consistency) | Official benchmark: "Eventual consistency: passed", 0 missing records, in all three scenarios | ✅ Met — a genuine strength, do not regress |
| FR-010 | Handle ~1,000,000 stored records representing ~1 month of data | Not directly evidenced by the three reported scenario summaries (accepted counts: 175.4K / 98.4K / 161.4K per scenario) | ⚠️ **At risk / unverified** — no scenario summary shown here reaches 1M rows; needs the full benchmark detail or a dedicated local test before assuming pass or fail |
| FR-011 | 1 aggregation request/sec sustained during the ingestion test | Aggregation latencies were measured throughout every scenario, implying the request cadence was exercised; rate compliance itself not separately reported | ⚠️ Unverified from the given summary alone |
| FR-012 | Retention deletes expired data without long-running locks or major ingestion disruption | `retention.repository.ts` uses bounded `FOR UPDATE SKIP LOCKED` batches, hourly, capped batch count | ✅ Met (not exercised by the benchmark's ~1-month-old dataset, but implementation matches the requirement) |
| FR-013 | README documents setup, API, schema, attribute strategy, retention, measured performance, limitations | README currently contains a stale self-reported local benchmark, explicitly superseded by the official result | ⚠️ **At risk** — out of scope for this feature's code changes, but must be corrected before final submission (tracked, not solved, here) |
| FR-014 | SQL injection is disqualifying; all queries parameterized | `logs.repository.ts`/`retention.repository.ts` use Drizzle's tagged `sql` templates and query builder throughout; no string concatenation of request input into SQL found in the audit | ✅ Met |

### Key Entities

- **Log entry**: timestamp, level, service, message, attributes (flat string/number/boolean map) —
  unchanged by this feature; no schema shape changes are in scope, only storage/access performance.
- **Benchmark scenario**: named run (Load / Stress / Breakpoint) with a target rate/duration and a
  reported metric bundle (throughput, latency percentiles, error rate, resource usage, correctness).
  Used here as the unit of before/after comparison.
- **Root cause**: a named, evidence-linked explanation for part of the throughput/latency gap,
  tagged confirmed or hypothesis (see [[research.md]]).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Official benchmark baseline-scenario achieved throughput increases materially from
  1,169.33 logs/sec toward the 15,000 logs/sec target, without any increase in `Rejected` or
  `Missing records` (both must stay at 0).
- **SC-002**: Official benchmark `Aggregate p95` across all three scenarios drops from the
  4.60–5.99 s range materially toward the 1 s target.
- **SC-003**: Official benchmark `HTTP error rate` in the Load and Breakpoint scenarios drops from
  15.14% / 22.10% toward 0%, without the Stress scenario's current 0% error rate regressing.
- **SC-004**: Official benchmark `Correctness checks`, `Reliability score`, `Correctness score`, and
  `Eventual consistency` remain at their current maximum values (75/75, 20/20, 15/15, passed) after
  every change.
- **SC-005**: Official benchmark overall score improves from 59.40/100 on re-submission after the
  proposed changes are implemented and verified.
- **SC-006**: Local reproduction harness (extended `scripts/load-test.ts` or equivalent) demonstrates
  the same directional improvement (throughput up, aggregate p95 down, error rate down) under the
  same container resource limits, *before* an official re-submission is spent on the change.

## Assumptions

- The official benchmark's exact concurrency model, batch size, and request pacing are not published
  to candidates; where methodology must be inferred, it is inferred from resource/latency/error-rate
  correlations and explicitly labeled as inference, not fact (Constitution Principle VII).
- The single benchmark report provided (submission `7VQZVZDZZXEMTPTY36FM8S0R78`) is the authoritative
  measurement for this planning cycle; the previously-committed README benchmark numbers are
  superseded and are not used as evidence anywhere in this spec or its plan.
- No code changes have been made since commit `3416eb3b0ab0` (the tested commit) other than the
  uncommitted, functionally-inert working-tree diffs already noted in the prior audit (whitespace-only
  changes to `src/db/index.ts` / `src/server/app.ts`) and the new, not-yet-applied autovacuum tuning
  migration — none of these are assumed to explain the gap, but they are noted so the "tested commit"
  baseline is unambiguous.
- Container resource limits (0.5 CPU/256 MB app, 1 CPU/1 GB PostgreSQL) are fixed constraints for this
  feature, not something to request changing.
- Re-submitting to the official load-generator portal is possible multiple times, so the plan can
  include a real official-benchmark verification step per change (or per small batch of changes), not
  just a one-shot guess.
