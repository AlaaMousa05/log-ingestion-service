import {
  pgTable,
  uuid,
  timestamp,
  varchar,
  text,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
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

 
    attributesText: jsonb("attributes_text")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),

    createdAt: timestamp("created_at", {
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
  },
 (table) => ({
  cursorIndex: index("logs_cursor_idx")
    .on(table.timestamp, table.id),


  serviceTimestampIdIndex: index("logs_service_timestamp_id_idx")
    .on(table.service, sql`${table.timestamp} DESC`, sql`${table.id} DESC`),

  levelTimestampIdIndex: index("logs_level_timestamp_id_idx")
    .on(table.level, sql`${table.timestamp} DESC`, sql`${table.id} DESC`),

  messageSearchIndex: index("logs_message_search_idx")
  .using("gin", sql`LOWER(${table.message}) gin_trgm_ops`),


  attributesTextIndex: index("logs_attributes_text_gin_idx")
    .using("gin", sql`${table.attributesText} jsonb_path_ops`),
}),
);