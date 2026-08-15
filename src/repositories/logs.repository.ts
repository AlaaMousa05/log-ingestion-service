import { db, ingestPool } from "../db/index.js";
import { logs } from "../db/schema.js";
import type {
  AggregateBucket,
  AggregateQuery,
  AttributeFilters,
  BucketSize,
  LogAttributes,
  LogEntry,
  LogQuery,
} from "../types/log.types.js";
import {
  and,
  desc,
  eq,
  gte,
  lt,
  sql,
  type SQL,
} from "drizzle-orm";
import { from as copyFrom } from "pg-copy-streams";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

/**
 * Case-insensitive substring match. The caller's text is treated as a literal,
 * so `%` and `_` in a search term match themselves rather than acting as
 * wildcards.
 */
function messageMatches(message: string): SQL {
  return sql`LOWER(${logs.message}) LIKE ${`%${escapeLikePattern(message.toLowerCase())}%`} ESCAPE '\\'`;
}

/**
 * Containment match against `attributes_text`, the all-strings mirror of
 * `attributes`, so a filter value from the query string matches regardless of
 * the JSON type it was ingested as.
 */
function attributesContain(attributes: AttributeFilters): SQL {
  return sql`${logs.attributesText} @> ${JSON.stringify(attributes)}::jsonb`;
}

/**
 * Fixed origin for `date_bin`, so bucket boundaries depend only on the bucket
 * width and never on the requested time window — two overlapping queries return
 * buckets that line up exactly.
 */
const BUCKET_ORIGIN = sql`TIMESTAMPTZ '2026-01-01 00:00:00+00'`;

const BUCKET_EXPRESSIONS: Record<BucketSize, SQL<string>> = {
  "1m": sql`date_bin('1 minute', ${logs.timestamp}, ${BUCKET_ORIGIN})`,
  "5m": sql`date_bin('5 minutes', ${logs.timestamp}, ${BUCKET_ORIGIN})`,
  "1h": sql`date_bin('1 hour', ${logs.timestamp}, ${BUCKET_ORIGIN})`,
  "1d": sql`date_bin('1 day', ${logs.timestamp}, ${BUCKET_ORIGIN})`,
};

function toAttributesText(attributes: LogAttributes): Record<string, string> {
  const text: Record<string, string> = {};

  for (const [key, value] of Object.entries(attributes)) {
    text[key] = String(value);
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
  const attributes = entry.attributes ?? {};

  return [
    entry.timestamp,
    entry.level,
    entry.service,
    entry.message,
    JSON.stringify(attributes),
    JSON.stringify(toAttributesText(attributes)),
  ].map(copyTextField).join("\t") + "\n";
}

export async function insertLogs(entries: LogEntry[]) {
  if (entries.length === 0) {
    return 0;
  }

  const client = await ingestPool.connect();

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
    conditions.push(messageMatches(query.message));
  }

  if (query.attributes && Object.keys(query.attributes).length > 0) {
    conditions.push(attributesContain(query.attributes));
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

export async function aggregateLogs(
  query: AggregateQuery,
): Promise<AggregateBucket[]> {
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
    conditions.push(messageMatches(query.message));
  }

  if (query.attributes && Object.keys(query.attributes).length > 0) {
    conditions.push(attributesContain(query.attributes));
  }

  const bucketExpression = BUCKET_EXPRESSIONS[query.bucket];

  if (!query.groupBy) {
    const result = await db.execute<AggregateBucket>(sql`
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

  const groupExpression =
    query.groupBy === "service" ? logs.service : logs.level;

  return db
    .select({
      start: bucketExpression,
      group: groupExpression,
      count: sql<number>`cast(count(*) as integer)`,
    })
    .from(logs)
    .where(and(...conditions))
    .groupBy(bucketExpression, groupExpression)
    .orderBy(bucketExpression);
}
