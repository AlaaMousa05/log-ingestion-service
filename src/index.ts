import { sql } from "drizzle-orm";
import { env } from "./config/env.js";
import { db } from "./db/index.js";
import { buildApp } from "./server/app.js";
import { startRetentionJob, type RetentionJob } from "./services/retention.job.js";

const app = buildApp();
let retentionJob: RetentionJob | undefined;
let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  app.log.info({ signal }, "shutting down");
  retentionJob?.stop();

  try {
    await app.close();
    process.exit(0);
  } catch (error) {
    app.log.error(error, "graceful shutdown failed");
    process.exit(1);
  }
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

try {

  await db.execute(sql`SELECT 1`);

  await app.listen({
    port: env.port,
    host: "0.0.0.0",
  });

  retentionJob = startRetentionJob();
  app.log.info(`Server listening on port ${env.port}`);
} catch (error) {
  app.log.error(error);
  await app.close().catch(() => undefined);
  process.exit(1);
}
