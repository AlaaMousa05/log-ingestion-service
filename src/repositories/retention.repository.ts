import { sql } from "drizzle-orm";
import { db } from "../db/index.js";

/** Deletes one bounded oldest-first batch and returns only its count. */
export async function deleteExpiredLogsBatch(
  cutoff: Date,
  batchSize: number,
): Promise<number> {
  const result = await db.execute(
    sql<{ deleted: string }>`
      WITH candidates AS (
        SELECT id
        FROM logs
        WHERE timestamp < ${cutoff}
        ORDER BY timestamp ASC
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      ),
      deleted AS (
        DELETE FROM logs
        USING candidates
        WHERE logs.id = candidates.id
        RETURNING 1
      )
      SELECT count(*) AS deleted FROM deleted
    `,
  );

  return Number(result.rows[0]?.deleted ?? 0);
}

/**
 * Drops rollup minutes that no longer have any logs behind them.
 *
 * Deriving the boundary from the oldest surviving row — rather than from the
 * retention cutoff — keeps `logs_rollup` exactly consistent with `logs` even
 * when a retention run stops early at its batch cap, leaving rows older than
 * the cutoff still present.
 */
export async function pruneRollupBefore(): Promise<number> {
  const result = await db.execute(
    sql`
      DELETE FROM logs_rollup
      WHERE bucket_minute < (
        SELECT COALESCE(
          date_bin('1 minute', min(timestamp), TIMESTAMPTZ '2026-01-01 00:00:00+00'),
          'infinity'::timestamptz
        )
        FROM logs
      )
    `,
  );

  return result.rowCount ?? 0;
}
