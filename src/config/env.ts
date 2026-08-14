import "dotenv/config";

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;
type LogLevel = (typeof LOG_LEVELS)[number];

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

function getLogLevel(value: string | undefined): LogLevel {
  if (value === undefined || value === "") {
    return "warn";
  }

  if (!LOG_LEVELS.includes(value as LogLevel)) {
    throw new Error(`LOG_LEVEL must be one of: ${LOG_LEVELS.join(", ")}`);
  }

  return value as LogLevel;
}

export const env = {
  logLevel: getLogLevel(process.env.LOG_LEVEL),

  port: getPositiveInteger(
    "PORT",
    process.env.PORT,
    8080,
    65_535,
  ),

  databaseUrl:
    process.env.DATABASE_URL ?? "",

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
};
