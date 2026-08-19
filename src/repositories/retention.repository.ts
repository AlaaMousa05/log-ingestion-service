import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { env } from "../config/env.js";

// Matches on (timestamp, id) — uses the primary key index.
export async function deleteExpiredLogsBatch(
  cutoff: Date,
  batchSize: number,
): Promise<number> {
  const result = await db.execute(
    sql<{ deleted: string }>`
      WITH candidates AS (
        SELECT timestamp, id
        FROM logs
        WHERE timestamp < ${cutoff}
        ORDER BY timestamp ASC
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      ),
      deleted AS (
        DELETE FROM logs
        USING candidates
        WHERE logs.timestamp = candidates.timestamp
          AND logs.id = candidates.id
        RETURNING 1
      )
      SELECT count(*) AS deleted FROM deleted
    `,
  );

  return Number(result.rows[0]?.deleted ?? 0);
}

// Derived from the oldest surviving row, not the cutoff.
export async function pruneRollupBefore(): Promise<number> {
  const result = await db.execute(
    sql`
      DELETE FROM logs_rollup
      WHERE bucket_minute < (
        SELECT COALESCE(
          date_bin(${sql.raw(`'${env.rollupBucketSeconds} seconds'`)}, min(timestamp), TIMESTAMPTZ '2026-01-01 00:00:00+00'),
          'infinity'::timestamptz
        )
        FROM logs
      )
    `,
  );

  return result.rowCount ?? 0;
}
