import { sql } from "drizzle-orm";
import { db } from "../db/index.js";

/**
 * Deletes one bounded oldest-first batch and returns only its count.
 *
 * `candidates` carries both primary-key columns, and the delete matches on both,
 * so the join back to `logs` can use the `(timestamp, id)` primary key. Matching
 * on `id` alone selects the same rows — `id` is a bigserial and unique on its own
 * — but no index leads with it, so PostgreSQL had to sequentially scan the whole
 * table and hash-join it against the batch. At 1M rows that was a 1,000,000-row
 * Seq Scan + Hash Join costing ~174ms and ~33.4k buffer hits per 2,500-row batch;
 * the two-column form plans as a Nested Loop over the primary key at ~9ms and
 * ~17.6k buffers.
 */
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
