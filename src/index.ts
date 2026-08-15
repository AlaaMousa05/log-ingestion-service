import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
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

  // Apply migrations programmatically before listening for requests, so /health can never
  // report ready until the schema is up to date.
  app.log.info("Applying database migrations...");
  await migrate(db, { migrationsFolder: "./src/db/migrations" });
  app.log.info("Database migrations applied successfully.");

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
