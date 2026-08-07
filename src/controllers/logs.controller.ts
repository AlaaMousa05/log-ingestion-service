import type { FastifyReply, FastifyRequest } from "fastify";
import { ingestLogs } from "../services/logs.service.js";
import { findLogs ,aggregateLogs } from "../repositories/logs.repository.js";
import {
  encodeCursor,
  decodeCursor,
} from "../utils/cursor.js";


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


const validLevels = [
  "debug",
  "info",
  "warn",
  "error",
];

function isValidDate(value: string) {
  const date = new Date(value);
  return !Number.isNaN(date.getTime());
}




export async function queryLogsController(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const query = request.query as Record<string, string | undefined>;

  if (
  query.level &&
  !validLevels.includes(query.level)
) {
  return reply.status(400).send({
    error: `invalid level: '${query.level}'`,
  });
}


if (
  query.since &&
  !isValidDate(query.since)
) {
  return reply.status(400).send({
    error: "invalid since timestamp",
  });
}


if (
  query.until &&
  !isValidDate(query.until)
) {
  return reply.status(400).send({
    error: "invalid until timestamp",
  });
}


if (
  query.since &&
  query.until &&
  new Date(query.until) < new Date(query.since)
) {
  return reply.status(400).send({
    error: "until must be after since",
  });
}
  
  
  const limit = query.limit
    ? Number(query.limit)
    : 100;

  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 1000
  ) {
    return reply.status(400).send({
      error: "invalid limit",
    });
  }

  let cursor;

  if (query.cursor) {
    const decoded = decodeCursor(query.cursor);

    if (!decoded) {
      return reply.status(400).send({
        error: "invalid cursor",
      });
    }

    cursor = {
      timestamp: new Date(decoded.timestamp),
      id: decoded.id,
    };
  }

  const attributes: Record<string, string> = {};

  for (const [key, value] of Object.entries(query)) {
    if (key.startsWith("attr.")) {
      attributes[key.slice(5)] = value!;
    }
  }
const rows = await findLogs({
  ...(query.service && {
    service: query.service,
  }),

  ...(query.level && {
    level: query.level,
  }),

  ...(query.since && {
    since: new Date(query.since),
  }),

  ...(query.until && {
    until: new Date(query.until),
  }),

  ...(query.q && {
    message: query.q,
  }),

  ...(Object.keys(attributes).length > 0 && {
    attributes,
  }),

  ...(cursor && {
    cursor,
  }),

  limit,
});

  const hasMore = rows.length > limit;

  const logs = hasMore
    ? rows.slice(0, limit)
    : rows;

    const logsResponse = logs.map((log) => ({
  id: log.id,
  timestamp: log.timestamp.toISOString(),
  level: log.level,
  service: log.service,
  message: log.message,
  attributes: log.attributes,
}));

  const last = logs[logs.length - 1];

  return reply.send({
  logs: logsResponse,
    next_cursor:
      hasMore && last
        ? encodeCursor({
            timestamp:
              last.timestamp.toISOString(),
            id: last.id,
          })
        : null,
  });
}




export async function aggregateLogsController(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const query =
    request.query as Record<string, string | undefined>;

  if (!query.since || !query.until) {
    return reply.status(400).send({
      error: "since and until are required",
    });
  }

  const since = new Date(query.since);
  const until = new Date(query.until);

  if (
    Number.isNaN(since.getTime()) ||
    Number.isNaN(until.getTime())
  ) {
    return reply.status(400).send({
      error: "invalid timestamp",
    });
  }

  if (until <= since) {
    return reply.status(400).send({
      error: "until must be after since",
    });
  }


  const bucket = query.bucket;

  if (
    bucket !== "1m" &&
    bucket !== "5m" &&
    bucket !== "1h" &&
    bucket !== "1d"
  ) {
    return reply.status(400).send({
      error: "invalid bucket",
    });
  }


  if (
    query.group_by &&
    query.group_by !== "service" &&
    query.group_by !== "level"
  ) {
    return reply.status(400).send({
      error: "invalid group_by",
    });
  }


  const attributes: Record<string, string> = {};

  for (const [key, value] of Object.entries(query)) {
    if (key.startsWith("attr.")) {
      attributes[key.slice(5)] = value!;
    }
  }


  const result = await aggregateLogs({
    since,
    until,
    bucket,
    ...(query.service && {
      service: query.service,
    }),
    ...(query.level && {
      level: query.level,
    }),
    ...(query.q && {
      message: query.q,
    }),
    ...(Object.keys(attributes).length > 0 && {
      attributes,
    }),
    ...(query.group_by && {
      groupBy: query.group_by as
        | "service"
        | "level",
    }),
  });


  return reply.send({
    buckets: result.map((row) => ({
      start:
        new Date(row.start as Date)
          .toISOString(),

      group:
        row.group ?? null,

      count:
        Number(row.count),
    })),
  });
}