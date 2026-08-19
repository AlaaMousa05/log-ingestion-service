import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { env } from "../config/env.js";

const { Pool } = pg;

const databaseUrl = env.databaseUrl;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is not defined");
}

// Separate pools — ingestion bursts can't starve queries.
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

// Dedicated pool so /health never queues behind application load.
export const healthPool = new Pool({
  connectionString: databaseUrl,
  max: 2,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

export const db = drizzle(queryPool);
