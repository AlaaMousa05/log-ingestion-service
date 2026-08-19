import "dotenv/config";

// Distinct from LOG_LEVELS (log.types.ts) — this is app diagnostics.
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

  // See specs/001-benchmark-perf-gap/code-rationale.md for the measurements.
  aggregateRollupEnabled: getBoolean(
    "AGGREGATE_ROLLUP_ENABLED",
    process.env.AGGREGATE_ROLLUP_ENABLED,
    true,
  ),

  rollupBucketSeconds: getPositiveInteger(
    "ROLLUP_BUCKET_SECONDS",
    process.env.ROLLUP_BUCKET_SECONDS,
    5,
    3600,
  ),

  port: getPositiveInteger(
    "PORT",
    process.env.PORT,
    8080,
    65_535,
  ),

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

  // Wait budget, not a query timeout.
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

  ingestCoalesceWindowMs: getPositiveInteger(
    "INGEST_COALESCE_WINDOW_MS",
    process.env.INGEST_COALESCE_WINDOW_MS,
    15,
    1_000,
  ),

  ingestCoalesceMaxBatchEntries: getPositiveInteger(
    "INGEST_COALESCE_MAX_BATCH_ENTRIES",
    process.env.INGEST_COALESCE_MAX_BATCH_ENTRIES,
    10_000,
    1_000_000,
  ),
};
