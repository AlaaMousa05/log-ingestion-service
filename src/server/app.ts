import Fastify, { type FastifyError } from "fastify";
import { registerRoutes } from "./routes.js";
import { ingestPool, queryPool, healthPool } from "../db/index.js";
import { env } from "../config/env.js";

// Messages node-postgres throws on pool exhaustion.
const POOL_EXHAUSTION_PATTERNS = [
  /timeout exceeded when trying to connect/i,
  /too many clients already/i,
  /remaining connection slots are reserved/i,
  /connection terminated/i,
];

function matchesPoolExhaustionPattern(message: string): boolean {
  return POOL_EXHAUSTION_PATTERNS.some((pattern) => pattern.test(message));
}

// Walks error.cause: Drizzle sometimes buries the real message there.
function isPoolExhaustionError(error: unknown): boolean {
  let current: unknown = error;

  for (let depth = 0; depth < 5 && current != null; depth++) {
    const message = current instanceof Error ? current.message : String(current);

    if (matchesPoolExhaustionPattern(message)) {
      return true;
    }

    current = current instanceof Error ? current.cause : undefined;
  }

  return false;
}

export function buildApp() {
  const app = Fastify({
    logger: { level: env.logLevel },
    bodyLimit: 1_048_576,
  });

  app.setErrorHandler((error, request, reply) => {
    const fastifyError = error as FastifyError;

    if (fastifyError.code === "FST_ERR_CTP_INVALID_JSON_BODY") {
      return reply.status(400).send({ error: "malformed JSON body" });
    }

    if (isPoolExhaustionError(error)) {
      request.log.warn(
        { err: error },
        "database connection pool exhausted, shedding load with 503",
      );
      return reply
        .status(503)
        .header("Retry-After", "1")
        .send({ error: "service temporarily overloaded, retry shortly" });
    }

    request.log.error(error);

    const clientStatusCode =
      fastifyError.statusCode && fastifyError.statusCode < 500
        ? fastifyError.statusCode
        : undefined;

    return reply.status(clientStatusCode ?? 500).send({
      error: clientStatusCode ? fastifyError.message : "internal server error",
    });
  });

  app.addHook("onClose", async () => {
    await Promise.all([ingestPool.end(), queryPool.end(), healthPool.end()]);
  });

  app.register(registerRoutes);

  return app;
}
