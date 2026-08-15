import { insertLogs } from "../repositories/logs.repository.js";
import { validateLogEntry } from "../validators/log.validator.js";
import { IngestCoalescer } from "./ingest-coalescer.js";
import { env } from "../config/env.js";
import type {
  IngestResult,
  LogEntry,
  LogsRequest,
  RejectedLog,
} from "../types/log.types.js";

// Single app-wide instance: coalescing only helps when concurrent requests
// share one window, which requires one coalescer serving all of them.
const coalescer = new IngestCoalescer(
  env.ingestCoalesceWindowMs,
  env.ingestCoalesceMaxBatchEntries,
  insertLogs,
);

function hasLogsArray(body: unknown): body is LogsRequest {
  return (
    typeof body === "object" &&
    body !== null &&
    "logs" in body &&
    Array.isArray(body.logs)
  );
}

/**
 * Validates a batch entry by entry and persists whatever survives. Invalid
 * entries never block the valid ones — they are reported back by index.
 */
export async function ingestLogs(body: unknown): Promise<IngestResult> {
  if (!hasLogsArray(body)) {
    return {
      error: "request body must contain a logs array",
    };
  }

  const validLogs: LogEntry[] = [];
  const rejected: RejectedLog[] = [];

  for (const [index, entry] of body.logs.entries()) {
    const result = validateLogEntry(entry);

    if (result.valid) {
      validLogs.push(result.log);
    } else {
      rejected.push({
        index,
        reason: result.reason,
      });
    }
  }

  if (validLogs.length === 0) {
    return {
      accepted: 0,
      rejected,
      allRejected: true,
    };
  }

  const accepted = await coalescer.submit(validLogs);

  return {
    accepted,
    rejected,
    allRejected: false,
  };
}
