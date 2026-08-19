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

// One instance app-wide, so concurrent requests share coalescing windows.
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
