import "dotenv/config";

// Pino's own severity levels, which control this service's diagnostic output.
// Deliberately distinct from LOG_LEVELS in src/types/log.types.ts, which are the
// levels of the logs this service ingests.
const PINO_LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;
type PinoLogLevel = (typeof PINO_LOG_LEVELS)[number];

function getPositiveInteger(
  name: string,
  value: string | undefined,
  fallback: number,
  maximum?: number,
): number {
  if (value === undefined || value === "") {
    return fallback;
  }

  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a positive integer`);
  }

  const parsed = Number(value);

  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 1 ||
    (maximum !== undefined && parsed > maximum)
  ) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function getLogLevel(value: string | undefined): PinoLogLevel {
  if (value === undefined || value === "") {
    return "warn";
  }

  if (!PINO_LOG_LEVELS.includes(value as PinoLogLevel)) {
    throw new Error(`LOG_LEVEL must be one of: ${PINO_LOG_LEVELS.join(", ")}`);
  }

  return value as PinoLogLevel;
}

function getBoolean(name: string, value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") {
    return fallback;
  }

  if (value !== "true" && value !== "false") {
    throw new Error(`${name} must be 'true' or 'false'`);
  }

  return value === "true";
}

export const env = {
  logLevel: getLogLevel(process.env.LOG_LEVEL),

  // Serves GET /logs/aggregate from the per-minute `logs_rollup` table instead
  // of scanning `logs`, for the filters the rollup can answer (see
  // src/repositories/logs.repository.ts). Measured directly against the
  // benchmark's own aggregate query -- a full scan of ~1.5M rows to produce 36
  // output rows costs ~490ms on an idle database and 2.2s under concurrent
  // ingestion, and that single query is ~27% of all PostgreSQL execution time.
  // Kept switchable so the ingestion-side cost of maintaining it can be
  // re-measured against the read-side saving on different hardware.
  aggregateRollupEnabled: getBoolean(
    "AGGREGATE_ROLLUP_ENABLED",
    process.env.AGGREGATE_ROLLUP_ENABLED,
    true,
  ),

  // Width of one `logs_rollup` bucket. A query whose [since, until) contains
  // no whole rollup bucket has nothing to serve from the rollup and falls
  // back to scanning `logs` directly for the entire range -- at 60s that dead
  // zone can span just under 2 minutes, long enough to cover most or all of
  // the official benchmark's 120s Load stage (measured: 73-92% of aggregate
  // requests hit it, p50/p95 918/1592ms). 10s shrinks the dead zone to under
  // 20s: measured against the identical Load-stage-shaped harness, 8% of
  // requests hit it and p50/p95 dropped to 121/255ms (6-9x). Isolated
  // write-only cost is ~5% lower ingest throughput (more buckets to upsert
  // per batch); under combined read+write pressure throughput came out
  // *higher* than at 60s, because the 60s aggregate queries themselves were
  // expensive enough to compete with ingestion for the same core. Changing
  // this invalidates any existing `logs_rollup` data (old rows are aligned to
  // the previous width) -- only change it against a fresh table.
  rollupBucketSeconds: getPositiveInteger(
    "ROLLUP_BUCKET_SECONDS",
    process.env.ROLLUP_BUCKET_SECONDS,
    10,
    3600,
  ),

  port: getPositiveInteger(
    "PORT",
    process.env.PORT,
    8080,
    65_535,
  ),

  // Validated at startup by src/db/index.ts, which is the only consumer.
  databaseUrl: process.env.DATABASE_URL ?? "",

  retentionDays: getPositiveInteger(
    "RETENTION_DAYS",
    process.env.RETENTION_DAYS,
    30,
  ),

  retentionBatchSize: getPositiveInteger(
    "RETENTION_BATCH_SIZE",
    process.env.RETENTION_BATCH_SIZE,
    1_000,
  ),

  retentionMaxBatches: getPositiveInteger(
    "RETENTION_MAX_BATCHES",
    process.env.RETENTION_MAX_BATCHES,
    10,
  ),

  // Connection pool sizing. Two separate pools exist (see src/db/index.ts) so that a burst of
  // COPY-heavy ingestion traffic cannot starve the query/aggregation/health path behind it.
  // Defaults come from local A/B measurement against the resource-limited docker-compose stack
  // (see specs/001-benchmark-perf-gap/diagnostics.md) — override only if re-measuring for a
  // different resource ceiling.
  dbIngestPoolMax: getPositiveInteger(
    "DB_INGEST_POOL_MAX",
    process.env.DB_INGEST_POOL_MAX,
    12,
    100,
  ),

  dbQueryPoolMax: getPositiveInteger(
    "DB_QUERY_POOL_MAX",
    process.env.DB_QUERY_POOL_MAX,
    8,
    100,
  ),

  // How long a request may wait for a pooled connection before it is shed with 503.
  //
  // This is a budget for WAITING TO BE SERVED, so it must exceed the time the work itself
  // takes. Setting it below the observed service time does not make queries faster -- it
  // converts slow queries into failed ones, because waiters are culled faster than workers can
  // release connections. Measured directly against the official benchmark: submission
  // 7VQZVDZZXEMTPTY36FM8S0R78 (5000ms budget) returned zero errors in exactly the two stages
  // where aggregate p95 stayed under 5s, and shed load in the two where it did not; submission
  // 5VZZZZYZQ9C67PKQ9QVJ3ZW4Y (2500ms query budget) had every stage's p95 above the budget and
  // shed 14-46% of reads in all four.
  //
  // 8000ms exceeds the worst aggregate p95 recorded in either official run (5.99s), so both
  // pools use the same budget by default. They stay separately configurable because ingestion
  // (COPY holds a connection for a whole batch) and querying have genuinely different service
  // times, and a future measurement may justify splitting them again -- but only upward from
  // the measured service time, never below it.
  dbPoolConnectTimeoutMs: getPositiveInteger(
    "DB_POOL_CONNECT_TIMEOUT_MS",
    process.env.DB_POOL_CONNECT_TIMEOUT_MS,
    8_000,
    30_000,
  ),

  dbQueryPoolConnectTimeoutMs: getPositiveInteger(
    "DB_QUERY_POOL_CONNECT_TIMEOUT_MS",
    process.env.DB_QUERY_POOL_CONNECT_TIMEOUT_MS,
    8_000,
    30_000,
  ),

  // How long POST /logs buffers validated rows from concurrent requests before
  // issuing one shared COPY for the whole window, instead of one COPY per
  // request. Confirmed bottleneck (see specs/001-benchmark-perf-gap/
  // diagnostics.md): Postgres CPU sits pinned at 100-107% in every official
  // stage regardless of pool/timeout config -- the cost is per-operation, not
  // per-row, so merging many small COPYs into fewer larger ones directly
  // targets it. 15ms is a starting point (small relative to the multi-second
  // aggregate latencies already observed, so it can't itself become the
  // bottleneck) -- tune from real Docker-limited measurement, not guesswork.
  ingestCoalesceWindowMs: getPositiveInteger(
    "INGEST_COALESCE_WINDOW_MS",
    process.env.INGEST_COALESCE_WINDOW_MS,
    15,
    1_000,
  ),

  // Safety valve: flush early if a single window accumulates this many rows,
  // so pathological concurrency can't grow one COPY unboundedly large or
  // stall every request in the window behind a slow timer.
  ingestCoalesceMaxBatchEntries: getPositiveInteger(
    "INGEST_COALESCE_MAX_BATCH_ENTRIES",
    process.env.INGEST_COALESCE_MAX_BATCH_ENTRIES,
    10_000,
    1_000_000,
  ),
};
