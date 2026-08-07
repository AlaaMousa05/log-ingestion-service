import { buildApp } from "./server/app.js";
import { env } from "./config/env.js";
import { startRetentionJob } from "./services/retention.job.js";

const app = buildApp();

startRetentionJob();

try {
  await app.listen({
    port: env.port,
    host: "0.0.0.0",
  });

  console.log(
    `Server listening on port ${env.port}`,
  );
} catch (error) {
  app.log.error(error);
  process.exit(1);
}