import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { env } from "../config/env.js";

const { Pool } = pg;

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is not defined");
}

// Two separate pools share the same PostgreSQL instance but are never mixed: ingestion (COPY
// holds one connection for a whole batch, so it needs its own budget) and query/health/retention
// (short statements that must stay responsive even while ingestion is saturating the ingest
// pool). A single shared pool lets a burst of concurrent POST /logs requests starve
// GET /logs/aggregate behind the same connections — measured directly in
// specs/001-benchmark-perf-gap/diagnostics.md, and the motivation for this split.
export const ingestPool = new Pool({
  connectionString: databaseUrl,
  max: env.dbIngestPoolMax,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: env.dbPoolConnectTimeoutMs,
});

export const queryPool = new Pool({
  connectionString: databaseUrl,
  max: env.dbQueryPoolMax,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: env.dbQueryPoolConnectTimeoutMs,
});

// A third, tiny, dedicated pool for GET /health only. Measured directly: under the sustained
// high-concurrency load this service is now tuned to survive, /health (sharing queryPool) saw
// latency spike up to 6.3s -- longer than docker-compose.yml's healthcheck `timeout: 3s`, which
// risks the container being marked unhealthy from pure query contention, not an actual outage.
// A liveness probe must never queue behind application load; its own timeout is short on
// purpose so a genuinely unreachable database is still reported quickly.
export const healthPool = new Pool({
  connectionString: databaseUrl,
  max: 2,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

export const db = drizzle(queryPool);
