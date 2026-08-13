import Fastify from "fastify";
import { registerRoutes } from "./routes.js";
import { ingestPool, queryPool, healthPool } from "../db/index.js";
import { env } from "../config/env.js";

// node-postgres (pg-pool) throws these exact message patterns when the
// connection pool cannot hand out a client — either because our own pool's
// `max` is fully checked out (client-side connectionTimeoutMillis) or
// because Postgres itself is refusing new connections server-side. These
// are transient overload conditions, not application bugs, so they must be
// shed with 503 + Retry-After rather than surfaced as a raw 500.
const POOL_EXHAUSTION_PATTERNS = [
  /timeout exceeded when trying to connect/i,
  /too many clients already/i,
  /remaining connection slots are reserved/i,
  /connection terminated/i,
];

function matchesPoolExhaustionPattern(message: string): boolean {
  return POOL_EXHAUSTION_PATTERNS.some((pattern) => pattern.test(message));
}

// Drizzle wraps driver errors as `DrizzleQueryError`, and -- depending on the exact internal
// code path a given query takes -- sometimes folds the underlying pg-pool message into its own
// `.message` and sometimes leaves it only on `.cause` (Node's standard Error cause-chaining).
// Checking `.message` alone under-detects: GET /logs and GET /logs/aggregate (both go through
// Drizzle) were measured falling through to a raw 500 instead of the correct 503+Retry-After
// under the exact same pool-exhaustion condition that POST /logs (raw pg.Pool, no Drizzle
// wrapping, no `.cause` layer) always classified correctly. Walk the cause chain, bounded to
// guard against a pathological cycle.
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
    const fastifyError = error as {
      code?: string;
      message: string;
      statusCode?: number;
    };

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
    await Promise.all([ingestPool.end(), queryPool.end(), healthPool.end()]);
  });

  app.register(registerRoutes);

  return app;
}