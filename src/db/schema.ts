import {
  pgTable,
  bigserial,
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
    attributesText: jsonb("attributes_text").$type<Record<string, string>>().notNull().default({}),
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
