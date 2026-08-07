import "dotenv/config";

function getNumber(
  value: string | undefined,
  fallback: number,
): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);

  return Number.isNaN(parsed)
    ? fallback
    : parsed;
}

export const env = {
  port: getNumber(
    process.env.PORT,
    8080,
  ),

  databaseUrl:
    process.env.DATABASE_URL ?? "",

  retentionDays: getNumber(
    process.env.RETENTION_DAYS,
    30,
  ),
};