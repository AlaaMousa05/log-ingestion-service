import type { FastifyReply, FastifyRequest } from "fastify";
import { ingestLogs } from "../services/logs.service.js";
import { aggregateLogs, findLogs } from "../repositories/logs.repository.js";
import { encodeCursor } from "../utils/cursor.js";
import {
  parseAggregateQuery,
  parseLogQuery,
} from "../validators/query.validator.js";

type LogRow = Awaited<ReturnType<typeof findLogs>>[number];

/**
 * `id` and `timestamp` already arrive in their response form (see findLogs), so
 * this only picks fields — no per-row BigInt or Date conversion.
 */
function serializeLog(log: LogRow) {
  return {
    id: log.id,
    timestamp: log.timestamp,
    level: log.level,
    service: log.service,
    message: log.message,
    attributes: log.attributes,
  };
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
  const parsed = parseLogQuery(request.query);

  if (!parsed.ok) {
    return reply.status(400).send({ error: parsed.error });
  }

  const query = parsed.value;

  // The repository returns exactly its requested limit. The controller owns
  // the one-row look-ahead needed to generate a next cursor.
  const rows = await findLogs({ ...query, limit: query.limit + 1 });

  const hasMore = rows.length > query.limit;
  const logs = hasMore ? rows.slice(0, query.limit) : rows;
  const last = logs.at(-1);

  return reply.send({
    logs: logs.map(serializeLog),
    next_cursor: hasMore && last
      ? encodeCursor({ timestamp: last.timestamp, id: last.id })
      : null,
  });
}

export async function aggregateLogsController(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const parsed = parseAggregateQuery(request.query);

  if (!parsed.ok) {
    return reply.status(400).send({ error: parsed.error });
  }

  const buckets = await aggregateLogs(parsed.value);

  return reply.send({
    buckets: buckets.map((bucket) => ({
      start: new Date(bucket.start).toISOString(),
      group: bucket.group,
      count: bucket.count,
    })),
  });
}
