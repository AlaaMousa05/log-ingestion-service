import { db, pool } from "../db/index.js";
import { logs } from "../db/schema.js";
import type { LogEntry, LogQuery, AggregateQuery } from "../types/log.types.js";
import {
  and,
  desc,
  eq,
  gte,
  lt,
  sql,
} from "drizzle-orm";
import { from as copyFrom } from "pg-copy-streams";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function toAttributesText(
  attributes: Record<string, string | number | boolean>,
): Record<string, string> {
  const text: Record<string, string> = {};

  for (const key in attributes) {
    text[key] = String(attributes[key]);
  }

  return text;
}

function copyTextField(value: string): string {
  return value.replace(/[\\\t\n\r]/g, (character) => {
    switch (character) {
      case "\\":
        return "\\\\";
      case "\t":
        return "\\t";
      case "\n":
        return "\\n";
      case "\r":
        return "\\r";
      default:
        return character;
    }
  });
}

function toCopyTextRow(entry: LogEntry): string {
  const attrs = entry.attributes ?? {};
  const strAttrs = JSON.stringify(attrs);
  const strAttrsText = JSON.stringify(toAttributesText(attrs));

  return [
    entry.timestamp,
    entry.level,
    entry.service,
    entry.message,
    strAttrs,
    strAttrsText,
  ].map(copyTextField).join("\t") + "\n";
}

export async function insertLogs(entries: LogEntry[]) {
  if (entries.length === 0) {
    return 0;
  }

  const client = await pool.connect();

  try {
    const copyStream = client.query(
      copyFrom(
        `COPY logs (timestamp, level, service, message, attributes, attributes_text)
         FROM STDIN WITH (FORMAT text)`,
      ),
    );

    const CHUNK_SIZE = 500;
    const source = Readable.from(
      (function* () {
        for (let i = 0; i < entries.length; i += CHUNK_SIZE) {
          const chunk = entries.slice(i, i + CHUNK_SIZE);
          let buffer = "";
          for (const entry of chunk) {
            buffer += toCopyTextRow(entry);
          }
          yield buffer;
        }
      })(),
    );

    await pipeline(source, copyStream);
  } finally {
    client.release();
  }

  return entries.length;
}

export async function findLogs(query: LogQuery) {
  const conditions = [];

  if (query.service) {
    conditions.push(eq(logs.service, query.service));
  }

  if (query.level) {
    conditions.push(eq(logs.level, query.level));
  }

  if (query.since) {
    conditions.push(gte(logs.timestamp, query.since));
  }

  if (query.until) {
    conditions.push(lt(logs.timestamp, query.until));
  }

  if (query.message) {
    conditions.push(
      sql`LOWER(${logs.message}) LIKE ${`%${escapeLikePattern(query.message.toLowerCase())}%`} ESCAPE '\\'`,
    );
  }

  if (query.attributes && Object.keys(query.attributes).length > 0) {
    conditions.push(
      sql`${logs.attributesText} @> ${JSON.stringify(query.attributes)}::jsonb`,
    );
  }

  if (query.cursor) {
    conditions.push(
      sql`(${logs.timestamp}, ${logs.id}) < (${query.cursor.timestamp}, ${query.cursor.id}::bigint)`,
    );
  }

  return db
    .select()
    .from(logs)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(logs.timestamp), desc(logs.id))
    .limit(query.limit);
}

export async function aggregateLogs(query: AggregateQuery) {
  const conditions = [
    gte(logs.timestamp, query.since),
    lt(logs.timestamp, query.until),
  ];

  if (query.service) {
    conditions.push(eq(logs.service, query.service));
  }

  if (query.level) {
    conditions.push(eq(logs.level, query.level));
  }

  if (query.message) {
    conditions.push(
      sql`LOWER(${logs.message}) LIKE ${`%${escapeLikePattern(query.message.toLowerCase())}%`} ESCAPE '\\'`,
    );
  }

  if (query.attributes && Object.keys(query.attributes).length > 0) {
    conditions.push(
      sql`${logs.attributesText} @> ${JSON.stringify(query.attributes)}::jsonb`,
    );
  }

  const bucketExpression =
    query.bucket === "1m"
      ? sql`date_bin('1 minute', ${logs.timestamp}, TIMESTAMPTZ '2026-01-01 00:00:00+00')`
      : query.bucket === "5m"
        ? sql`date_bin('5 minutes', ${logs.timestamp}, TIMESTAMPTZ '2026-01-01 00:00:00+00')`
        : query.bucket === "1h"
          ? sql`date_bin('1 hour', ${logs.timestamp}, TIMESTAMPTZ '2026-01-01 00:00:00+00')`
          : sql`date_bin('1 day', ${logs.timestamp}, TIMESTAMPTZ '2026-01-01 00:00:00+00')`;

  const groupExpression =
    query.groupBy === "service"
      ? logs.service
      : query.groupBy === "level"
        ? logs.level
        : sql`NULL`;

  if (!query.groupBy) {
    const result = await db.execute<{
      start: Date;
      group: null;
      count: string;
    }>(sql`
      WITH aggregated AS MATERIALIZED (
        SELECT ${bucketExpression} AS start, cast(count(*) as integer) AS count
        FROM ${logs}
        WHERE ${and(...conditions)}
        GROUP BY ${bucketExpression}
      )
      SELECT start, NULL::text AS "group", count
      FROM aggregated
      ORDER BY start
    `);

    return result.rows;
  }

  const queryBuilder = db
    .select({
      start: bucketExpression,
      group: groupExpression,
      count: sql<number>`cast(count(*) as integer)`,
    })
    .from(logs)
    .where(and(...conditions));

  if (query.groupBy) {
    return queryBuilder
      .groupBy(bucketExpression, groupExpression)
      .orderBy(bucketExpression);
  }

  return queryBuilder
    .groupBy(bucketExpression)
    .orderBy(bucketExpression);
}
