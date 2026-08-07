import {
  pgTable,
  uuid,
  timestamp,
  varchar,
  text,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

export const logs = pgTable(
  "logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    timestamp: timestamp("timestamp", {
      withTimezone: true,
    }).notNull(),

    level: varchar("level", {
      length: 10,
    }).notNull(),

    service: varchar("service", {
      length: 255,
    }).notNull(),

    message: text("message").notNull(),

    attributes: jsonb("attributes")
      .$type<Record<string, string | number | boolean>>()
      .notNull()
      .default({}),

    createdAt: timestamp("created_at", {
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
  },
 (table) => ({
  timestampIndex: index("logs_timestamp_idx")
    .on(table.timestamp),

  serviceIndex: index("logs_service_idx")
    .on(table.service),

  levelIndex: index("logs_level_idx")
    .on(table.level),

  cursorIndex: index("logs_cursor_idx")
    .on(table.timestamp, table.id),
}),
);