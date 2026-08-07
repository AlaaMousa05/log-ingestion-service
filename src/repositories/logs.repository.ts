import { db } from "../db/index.js";
import { logs } from "../db/schema.js";
import type { LogEntry } from "../types/log.types.js";
import {
  and,
  desc,
  eq,
  gte,
  lt,
  sql,
} from "drizzle-orm";

export async function insertLogs(entries: LogEntry[]) {
  if (entries.length === 0) {
    return 0;
  }

  const values = entries.map((entry) => ({
    timestamp: new Date(entry.timestamp),
    level: entry.level,
    service: entry.service,
    message: entry.message,
    attributes: entry.attributes ?? {},
  }));

  await db.insert(logs).values(values);

  return entries.length;
}


export interface LogQuery {
  service?: string;
  level?: string;
  since?: Date;
  until?: Date;
  message?: string;
  attributes?: Record<string, string>;
  limit: number;
  cursor?: {
    timestamp: Date;
    id: string;
  };
}

export async function findLogs(query: LogQuery) {
  const conditions = [];

  if (query.service) {
    conditions.push(
      eq(logs.service, query.service),
    );
  }

  if (query.level) {
    conditions.push(
      eq(logs.level, query.level),
    );
  }

  if (query.since) {
    conditions.push(
      gte(logs.timestamp, query.since),
    );
  }

  if (query.until) {
    conditions.push(
      lt(logs.timestamp, query.until),
    );
  }

  if (query.message) {
    conditions.push(
      sql`LOWER(${logs.message}) LIKE ${`%${query.message.toLowerCase()}%`}`,
    );
  }

  if (query.attributes) {
    for (const [key, value] of Object.entries(query.attributes)) {
      conditions.push(
        sql`${logs.attributes} @> ${JSON.stringify({
          [key]: value,
        })}`,
      );
    }
  }

  if (query.cursor) {
    conditions.push(
      sql`(${logs.timestamp}, ${logs.id}) < (${query.cursor.timestamp}, ${query.cursor.id})`,
    );
  }

  return db
    .select()
    .from(logs)
    .where(
      conditions.length > 0
        ? and(...conditions)
        : undefined,
    )
    .orderBy(
      desc(logs.timestamp),
      desc(logs.id),
    )
    .limit(query.limit + 1);
}


export interface AggregateQuery {
  since: Date;
  until: Date;
  bucket: "1m" | "5m" | "1h" | "1d";
  groupBy?: "service" | "level";
  service?: string;
  level?: string;
  message?: string;
  attributes?: Record<string, string>;
}


export async function aggregateLogs(
  query: AggregateQuery,
) {
  const conditions = [
    gte(logs.timestamp, query.since),
    lt(logs.timestamp, query.until),
  ];

  if (query.service) {
    conditions.push(
      eq(logs.service, query.service),
    );
  }

  if (query.level) {
    conditions.push(
      eq(logs.level, query.level),
    );
  }

  if (query.message) {
    conditions.push(
      sql`LOWER(${logs.message}) LIKE ${`%${query.message.toLowerCase()}%`}`,
    );
  }

  if (query.attributes) {
    for (const [key, value] of Object.entries(query.attributes)) {
      conditions.push(
        sql`${logs.attributes} @> ${JSON.stringify({
          [key]: value,
        })}`,
      );
    }
  }

  const bucketExpression =
    query.bucket === "1m"
      ? sql`date_trunc('minute', ${logs.timestamp})`
      : query.bucket === "5m"
        ? sql`date_trunc('minute', ${logs.timestamp}) - 
          ((extract(minute from ${logs.timestamp})::int % 5) * interval '1 minute')`
        : query.bucket === "1h"
          ? sql`date_trunc('hour', ${logs.timestamp})`
          : sql`date_trunc('day', ${logs.timestamp})`;


  const groupExpression =
    query.groupBy === "service"
      ? logs.service
      : query.groupBy === "level"
        ? logs.level
        : sql`NULL`;


  const queryBuilder = db
  .select({
    start: bucketExpression,
    group: groupExpression,
    count: sql<number>`count(*)`,
  })
  .from(logs)
  .where(and(...conditions));


if (query.groupBy) {
  return queryBuilder
    .groupBy(
      bucketExpression,
      groupExpression,
    )
    .orderBy(bucketExpression);
}


return queryBuilder
  .groupBy(bucketExpression)
  .orderBy(bucketExpression);
}