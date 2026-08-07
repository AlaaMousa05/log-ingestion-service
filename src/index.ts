import "dotenv/config";
import { buildApp } from "./server/app.js";

const app = buildApp();

const port = Number(process.env.PORT ?? 8080);

try {
  await app.listen({
    port,
    host: "0.0.0.0",
  });

  console.log(`Server listening on port ${port}`);
} catch (error) {
  app.log.error(error);
  process.exit(1);
}