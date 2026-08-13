import type { FastifyReply, FastifyRequest } from "fastify";
import { ingestLogs } from "../services/logs.service.js";
import { aggregateLogs, findLogs } from "../repositories/logs.repository.js";
import { decodeCursor, encodeCursor } from "../utils/cursor.js";
import { parseIsoTimestamp } from "../utils/timestamp.js";
import type { LogLevel } from "../types/log.types.js";
const VALID_LEVELS = ["debug", "info", "warn", "error"] as const;

type QueryParameters = Record<string, string | undefined>;

function getQueryParameters(
  request: FastifyRequest,
): QueryParameters | null {
  const query = request.query as Record<string, unknown>;

  if (Object.values(query).some((value) => value !== undefined && typeof value !== "string")) {
    return null;
  }

  return query as QueryParameters;
}

function getAttributeFilters(
  query: QueryParameters,
): Record<string, string> | null {
  const attributes: Record<string, string> = {};

  for (const [key, value] of Object.entries(query)) {
    if (!key.startsWith("attr.")) {
      continue;
    }

    const attributeKey = key.slice(5);

    if (!attributeKey || value === undefined) {
      return null;
    }

    attributes[attributeKey] = value;
  }

  return attributes;
}

function invalidQuery(reply: FastifyReply) {
  return reply.status(400).send({
    error: "query parameters must be single string values",
  });
}

function validateLevel(level: string | undefined, reply: FastifyReply): boolean {
  if (level && !VALID_LEVELS.includes(level as typeof VALID_LEVELS[number])) {
    void reply.status(400).send({
      error: `invalid level: '${level}'`,
    });
    return false;
  }

  return true;
}

export async function ingestLogsController(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const result = await ingestLogs(request.body);

  if ("error" in result) {
    return reply.status(400).send({
      error: result.error,
    });
  }

  if (result.allRejected) {
    return reply.status(400).send({
      accepted: 0,
      rejected: result.rejected,
    });
  }

  return reply.status(200).send({
    accepted: result.accepted,
    rejected: result.rejected,
  });
}

export async function queryLogsController(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const query = getQueryParameters(request);

  if (!query) {
    return invalidQuery(reply);
  }

  if (!validateLevel(query.level, reply)) {
    return reply;
  }

  const since = query.since ? parseIsoTimestamp(query.since) : undefined;
  const until = query.until ? parseIsoTimestamp(query.until) : undefined;

  if (query.since && !since) {
    return reply.status(400).send({ error: "invalid since timestamp" });
  }

  if (query.until && !until) {
    return reply.status(400).send({ error: "invalid until timestamp" });
  }

  if (since && until && until <= since) {
    return reply.status(400).send({
      error: "until must be after since",
    });
  }

  const limit = query.limit === undefined ? 100 : Number(query.limit);

  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
    return reply.status(400).send({ error: "invalid limit" });
  }

  let cursor: { timestamp: Date; id: string } | undefined;

  if (query.cursor) {
    const decoded = decodeCursor(query.cursor);
    const timestamp = decoded ? parseIsoTimestamp(decoded.timestamp) : null;

    if (!decoded || !timestamp) {
      return reply.status(400).send({ error: "invalid cursor" });
    }

    cursor = { timestamp, id: decoded.id };
  }

  const attributes = getAttributeFilters(query);

  if (!attributes) {
    return reply.status(400).send({ error: "invalid attribute filter" });
  }

  const rows = await findLogs({
    ...(query.service && { service: query.service }),
    ...(query.level && { level: query.level as LogLevel }),
    ...(since && { since }),
    ...(until && { until }),
    ...(query.q && { message: query.q }),
    ...(Object.keys(attributes).length > 0 && { attributes }),
    ...(cursor && { cursor }),
    // The repository returns exactly its requested limit. The controller owns
    // the one-row look-ahead needed to generate a next cursor.
    limit: limit + 1,
  });

  const hasMore = rows.length > limit;
  const logs = hasMore ? rows.slice(0, limit) : rows;
  const last = logs.at(-1);

  return reply.send({
    logs: logs.map((log) => ({
      id: log.id.toString(),
      timestamp: log.timestamp.toISOString(),
      level: log.level,
      service: log.service,
      message: log.message,
      attributes: log.attributes,
    })),
    next_cursor: hasMore && last
      ? encodeCursor({ timestamp: last.timestamp.toISOString(), id: last.id.toString() })
      : null,
  });
}

export async function aggregateLogsController(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const query = getQueryParameters(request);

  if (!query) {
    return invalidQuery(reply);
  }

  if (!query.since || !query.until) {
    return reply.status(400).send({ error: "since and until are required" });
  }

  if (!validateLevel(query.level, reply)) {
    return reply;
  }

  const since = parseIsoTimestamp(query.since);
  const until = parseIsoTimestamp(query.until);

  if (!since || !until) {
    return reply.status(400).send({ error: "invalid timestamp" });
  }

  if (until <= since) {
    return reply.status(400).send({ error: "until must be after since" });
  }

  const bucket = query.bucket;

  if (bucket !== "1m" && bucket !== "5m" && bucket !== "1h" && bucket !== "1d") {
    return reply.status(400).send({ error: "invalid bucket" });
  }

  if (query.group_by && query.group_by !== "service" && query.group_by !== "level") {
    return reply.status(400).send({ error: "invalid group_by" });
  }

  const attributes = getAttributeFilters(query);

  if (!attributes) {
    return reply.status(400).send({ error: "invalid attribute filter" });
  }

  const result = await aggregateLogs({
    since,
    until,
    bucket,
    ...(query.service && { service: query.service }),
    ...(query.level && { level: query.level as LogLevel }),
    ...(query.q && { message: query.q }),
    ...(Object.keys(attributes).length > 0 && { attributes }),
    ...(query.group_by && {
      groupBy: query.group_by as "service" | "level",
    }),
  });

  return reply.send({
    buckets: result.map((row) => ({
      start: new Date(row.start as Date).toISOString(),
      group: row.group ?? null,
      count: Number(row.count),
    })),
  });
}
