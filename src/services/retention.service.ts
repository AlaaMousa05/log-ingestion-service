import { db } from "../db/index.js";
import { logs } from "../db/schema.js";
import { lt } from "drizzle-orm";
import { env } from "../config/env.js";


export async function deleteExpiredLogs() {
  const cutoff = new Date();

  cutoff.setDate(
    cutoff.getDate() - env.retentionDays,
  );

  const result = await db
    .delete(logs)
    .where(
      lt(
        logs.timestamp,
        cutoff,
      ),
    )
    .returning({
      id: logs.id,
    });


  console.log(
    `Retention cleanup deleted ${result.length} logs older than ${cutoff.toISOString()}`,
  );


  return result.length;
}