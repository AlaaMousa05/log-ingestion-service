import type { FastifyInstance } from "fastify";
import { healthPool } from "../db/index.js";

export async function healthRoute(app: FastifyInstance) {
  app.get("/health", async (_request, reply) => {
    try {
      await healthPool.query("SELECT 1");

      return reply.status(200).send({
        status: "ok",
      });
    } catch {
      return reply.status(503).send({
        status: "unhealthy",
      });
    }
  });
}
