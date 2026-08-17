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
    primaryKey({ columns: [table.timestamp, table.id] }),
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

export const logsRollup = pgTable(
  "logs_rollup",
  {
    bucketMinute: timestamp("bucket_minute", { withTimezone: true }).notNull(),
    service: text("service").notNull(),
    level: logLevelEnum("level").notNull(),
    shard: smallint("shard").notNull(),
    count: bigint("count", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.bucketMinute, table.service, table.level, table.shard],
    }),
  ]
);
