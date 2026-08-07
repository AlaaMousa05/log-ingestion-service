import type { FastifyInstance } from "fastify";
import { db } from "../db/index.js";
import { sql } from "drizzle-orm";

export async function healthRoute(app: FastifyInstance) {
  app.get("/health", async (_request, reply) => {
    try {
      await db.execute(sql`SELECT 1`);

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