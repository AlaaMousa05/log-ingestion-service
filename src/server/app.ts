import Fastify from "fastify";
import { registerRoutes } from "./routes.js";
import { pool } from "../db/index.js";
import { env } from "../config/env.js";

export function buildApp() {
  const app = Fastify({
    logger: { level: env.logLevel },
    bodyLimit: 1_048_576,
  });

  app.setErrorHandler((error, request, reply) => {
    const fastifyError = error as {
      code?: string;
      message: string;
      statusCode?: number;
    };

    if (fastifyError.code === "FST_ERR_CTP_INVALID_JSON_BODY") {
      return reply.status(400).send({ error: "malformed JSON body" });
    }

    request.log.error(error);

    return reply.status(
      fastifyError.statusCode && fastifyError.statusCode < 500
        ? fastifyError.statusCode
        : 500,
    ).send({
      error: fastifyError.statusCode && fastifyError.statusCode < 500
        ? fastifyError.message
        : "internal server error",
    });
  });

  app.addHook("onClose", async () => {
    await pool.end();
  });

  app.register(registerRoutes);

  return app;
}
