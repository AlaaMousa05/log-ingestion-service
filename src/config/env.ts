import "dotenv/config";

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

export const env = {
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
};
