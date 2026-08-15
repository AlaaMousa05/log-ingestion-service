# Quickstart: Baseline → Change → Test → Benchmark Runbook

**Feature**: [[spec.md]] | **Plan**: [[plan.md]]

This is the concrete, runnable checklist for validating any change proposed in [[plan.md]]. It does
not contain implementation code — only the sequence of commands and what to record at each step.
Nothing here is executed until the plan is approved.

## 0. Prerequisites

- Docker and Docker Compose available locally.
- The exact `docker-compose.yml` resource limits are respected for every measurement (`cpus`/`mem_limit`
  on both `app` and `postgres` services) — never benchmark against an unconstrained local Postgres, or
  the numbers will not be comparable to the official report.
- No `.env` overrides that loosen the documented defaults during a benchmark run.

## 1. Capture the current baseline (once, before any change)

```bash
# Clean slate
docker compose down -v

# Build and start exactly as the grader would
docker compose up --build -d

# Wait for health
for i in $(seq 1 30); do curl --fail http://localhost:8080/health && break; sleep 2; done

# Run the existing local harness as-is (pre-B3 upgrade) to record the current local number
# for comparison purposes only — this is NOT expected to match the official number, and that
# mismatch is itself the subject of research.md Root Cause #4.
TOTAL_LOGS=1000000 BATCH_SIZE=2500 WORKERS=6 CAPTURE_DOCKER_STATS=true npm run load-test | tee baseline-local-run.json

docker compose down -v
```

Record, alongside `baseline-local-run.json`:
- The official report already in hand: submission `7VQZVZDZZXEMTPTY36FM8S0R78`, commit `3416eb3b0ab0`
  (tables reproduced in [[research.md]] §1). This is the authoritative baseline — the local run above
  is a secondary reference point, not a substitute.

## 2. Phase 0 diagnostics (A1–A3)

Run these against the same resource-limited `docker compose up` stack. Each is additive/temporary;
none changes production request/response behavior.

- **A1 (pool wait telemetry)**: with temporary debug-level logging of pool wait state added, run a
  burst of concurrent `POST /logs` requests (e.g., ≥10 concurrent, exceeding `pool.max: 7`) and confirm
  whether requests queue and how long they wait before acquiring a connection or hitting the 503 path.
- **A2 (EXPLAIN + statement stats)**: while ingestion load is active, run:
  ```sql
  EXPLAIN (ANALYZE, BUFFERS)
  SELECT date_bin('1 hour', "timestamp", TIMESTAMPTZ '2026-01-01 00:00:00+00') AS start,
         count(*) AS count
  FROM logs
  WHERE "timestamp" >= now() - interval '1 hour' AND "timestamp" < now()
  GROUP BY 1
  ORDER BY 1;
  ```
  against the running container's Postgres, and separately inspect `pg_stat_statements` (enable the
  extension if not already available) or sample `pg_stat_activity` during the same window, to attribute
  CPU cost.
- **A3 (higher-concurrency local harness)**: extend `scripts/load-test.ts` (or add a sibling script)
  to issue requests with materially higher realized concurrency / open-loop pacing than the current
  fixed 6-worker closed loop, and re-run step 1's harness command with the new script. Compare the
  resulting throughput/latency/error-rate shape to the official report's numbers.

Record each diagnostic's raw output under `specs/001-benchmark-perf-gap/diagnostics/` (created when
Phase 0 actually runs) so [[research.md]]'s hypotheses can be marked confirmed/refuted with a linked
artifact, not just narrative.

## 3. Implement exactly one Phase B change

Follow [[plan.md]]'s Phase B ordering (B1 before B2 before/alongside B3, per the Prioritization
table). Do not combine two Phase B items in the same iteration.

## 4. Test gate (must pass before any benchmark run)

```bash
npm run typecheck
npm run build
npm test
```

Then, against a running `docker compose up` stack:

```bash
bash scripts/audit-run.sh
```

All existing assertions must pass unmodified. If a new test was added for a specific Phase B item
(e.g., B1's "aggregate stays responsive during concurrent ingestion" integration test), it must also
pass.

## 5. Local benchmark (directional check, before spending an official re-submission)

```bash
docker compose down -v
docker compose up --build -d
for i in $(seq 1 30); do curl --fail http://localhost:8080/health && break; sleep 2; done

TOTAL_LOGS=1000000 BATCH_SIZE=2500 WORKERS=6 CAPTURE_DOCKER_STATS=true npm run load-test | tee after-change-local-run.json
# Plus the A3-upgraded harness, once it exists, run the same way for a second data point.

docker compose down -v
```

Compare `after-change-local-run.json` against `baseline-local-run.json` (and, once available, the
prior iteration's local run). Proceed to step 6 only if this shows improvement or no regression in:
throughput, ingestion p95, aggregation p95, error/failure counts, and container CPU/memory (via
`docker_resource_samples` when `CAPTURE_DOCKER_STATS=true`).

## 6. Official benchmark verification

Submit the unchanged, tested commit to `https://loadgen.foothilltech.net/`. Record:

- Score and rank
- Full metric table for Load / Stress / Breakpoint (same shape as [[research.md]] §1)
- Correctness/reliability/eventual-consistency figures — confirm they remain at their current
  maximum values

## 7. Compare and record

Append a new row/table to a running log (e.g., `specs/001-benchmark-perf-gap/benchmark-log.md`,
created on first use) with: commit hash, change implemented, local before/after, official before/after,
and a one-line verdict (kept / reverted / needs further diagnosis). This turns the plan's Prioritization
table into a real, evidence-linked history instead of a one-time guess.

## 8. Repeat

Return to step 3 for the next Phase B item, using the just-recorded official report as the new
baseline for that item's comparison — per [[plan.md]]'s Baseline → Change → Test → Benchmark strategy.
