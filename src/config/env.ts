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

  // Ingestion can tolerate waiting for a connection -- a slow-but-eventually-accepted COPY beats
  // a dropped batch. Queries are a different contract: a query that has to wait 8s for a
  // connection just to then run is exactly what inflates GET /logs/aggregate's own p95 under
  // heavy concurrent load, without helping ingestion at all (see
  // specs/001-benchmark-perf-gap/diagnostics.md Round 4/5). Query requests should fail fast
  // (503) instead, matching an interactive-query contract rather than a bulk-write one.
  dbPoolConnectTimeoutMs: getPositiveInteger(
    "DB_POOL_CONNECT_TIMEOUT_MS",
    process.env.DB_POOL_CONNECT_TIMEOUT_MS,
    8_000,
    30_000,
  ),

  dbQueryPoolConnectTimeoutMs: getPositiveInteger(
    "DB_QUERY_POOL_CONNECT_TIMEOUT_MS",
    process.env.DB_QUERY_POOL_CONNECT_TIMEOUT_MS,
    2_500,
    30_000,
  ),
};
