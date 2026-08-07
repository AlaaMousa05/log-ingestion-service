import { insertLogs } from "../repositories/logs.repository.js";
import { validateLogEntry } from "../validators/log.validator.js";
import type {
  LogsRequest,
  RejectedLog,
  LogEntry,
} from "../types/log.types.js";

export async function ingestLogs(body: unknown) {
  if (
    typeof body !== "object" ||
    body === null ||
    !("logs" in body) ||
    !Array.isArray((body as LogsRequest).logs)
  ) {
    return {
      error: "request body must contain a logs array",
    };
  }

  const entries = (body as LogsRequest).logs;

  const validLogs: LogEntry[] = [];
  const rejected: RejectedLog[] = [];

  for (let index = 0; index < entries.length; index++) {
    const result = validateLogEntry(entries[index]);

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

  const accepted = await insertLogs(validLogs);

  return {
    accepted,
    rejected,
    allRejected: false,
  };
}