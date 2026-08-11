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

// 1. Enum متوافق مع قيم LOG_LEVELS في مشروعك
export const logLevelEnum = pgEnum("log_level", [
  "debug",
  "info",
  "warn",
  "error",
]);

export const logs = pgTable(
  "logs",
  {
    // 2. استخدام bigserial التابع لـ Drizzle ORM بدلاً من bigidentity
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
    // 3. المفتاح الرئيسي المركب
    primaryKey({ columns: [table.timestamp, table.id] }),

    // 4. الفهارس المركبة الفعالة
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