import {
  pgTable,
  bigserial,
  bigint,
  smallint,
  timestamp,
  text,
  jsonb,
  index,
  pgEnum,
  primaryKey,
} from "drizzle-orm/pg-core";

// Mirrors LOG_LEVELS in src/types/log.types.ts
export const logLevelEnum = pgEnum("log_level", [
  "debug",
  "info",
  "warn",
  "error",
]);

export const logs = pgTable(
  "logs",
  {
    id: bigserial("id", { mode: "bigint" }).notNull(),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
    level: logLevelEnum("level").notNull(),
    service: text("service").notNull(),
    message: text("message").notNull(),
    attributes: jsonb("attributes").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // Composite primary key: also backs descending pagination/cursor comparisons and the
    // retention delete's timestamp range scan (see src/repositories/*.ts).
    primaryKey({ columns: [table.timestamp, table.id] }),

    // Query-aligned composite indexes for the two single-dimension filters.
    index("idx_logs_service_timestamp_id").on(
      table.service,
      table.timestamp,
      table.id
    ),
    index("idx_logs_level_timestamp_id").on(
      table.level,
      table.timestamp,
      table.id
    ),
  ]
);

/**
 * Pre-aggregated per-minute counts, maintained in the same transaction as the
 * COPY that writes `logs` (see src/repositories/logs.repository.ts), so the two
 * are never observably out of step.
 *
 * `logs` remains the sole source of truth: this table holds nothing that cannot
 * be recomputed from it, and GET /logs/aggregate falls back to scanning `logs`
 * for any filter the rollup cannot answer (message substring, attributes) and
 * for the partial minutes at either edge of the requested range.
 *
 * Minute is the finest bucket the API exposes, so every supported bucket size
 * (1m/5m/1h/1d) is an exact multiple of one rollup row. Grouping by service and
 * by level are both supported because the key carries both dimensions.
 */
export const logsRollup = pgTable(
  "logs_rollup",
  {
    bucketMinute: timestamp("bucket_minute", { withTimezone: true }).notNull(),
    service: text("service").notNull(),
    level: logLevelEnum("level").notNull(),
    // Counter shard. A single row per (minute, service, level) made every
    // concurrent ingest transaction contend for the same handful of counters;
    // spreading them lets concurrent writers land on different rows. Readers
    // always SUM, so the shard is invisible above this table.
    shard: smallint("shard").notNull(),
    count: bigint("count", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.bucketMinute, table.service, table.level, table.shard],
    }),
  ]
);
