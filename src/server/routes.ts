import type { FastifyInstance } from "fastify";
import { healthRoute } from "../routes/health.route.js";
import { logsRoute } from "../routes/logs.route.js";

export async function registerRoutes(app: FastifyInstance) {
  await app.register(healthRoute);
  await app.register(logsRoute);
}
