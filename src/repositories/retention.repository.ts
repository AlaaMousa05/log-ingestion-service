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
