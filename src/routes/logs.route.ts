import type { FastifyInstance } from "fastify";

import {
  ingestLogsController,
  queryLogsController,
  aggregateLogsController,
} from "../controllers/logs.controller.js";


export async function logsRoute(app: FastifyInstance) {
  app.post("/logs", ingestLogsController);

  app.get("/logs", queryLogsController);

  app.get(
    "/logs/aggregate",
    aggregateLogsController,
  );
}