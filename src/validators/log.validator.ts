import {
  LOG_LEVELS,
  type LogAttributes,
  type LogEntry,
} from "../types/log.types.js";
import { parseIsoTimestamp } from "../utils/timestamp.js";

const MAX_FUTURE_MS = 5 * 60 * 1000;

function containsNullCharacter(value: string): boolean {
  return value.includes("\0");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
}

function isValidAttributes(value: unknown): value is LogAttributes {
  if (!isPlainObject(value)) {
    return false;
  }

  for (const attributeValue of Object.values(value)) {
    const type = typeof attributeValue;

    if (
      type !== "string" &&
      type !== "number" &&
      type !== "boolean"
    ) {
      return false;
    }

    if (type === "number" && !Number.isFinite(attributeValue)) {
      return false;
    }
  }

  return true;
}

export function validateLogEntry(
  value: unknown,
): { valid: true; log: LogEntry } | { valid: false; reason: string } {
  if (!isPlainObject(value)) {
    return {
      valid: false,
      reason: "log entry must be an object",
    };
  }

  const timestamp = value.timestamp;

  if (typeof timestamp !== "string") {
    return {
      valid: false,
      reason: "timestamp is required",
    };
  }

  const parsedTimestamp = parseIsoTimestamp(timestamp);

  if (!parsedTimestamp) {
    return {
      valid: false,
      reason: "invalid timestamp",
    };
  }

  if (parsedTimestamp.getTime() >= Date.now() + MAX_FUTURE_MS) {
    return {
      valid: false,
      reason: "timestamp cannot be more than five minutes in the future",
    };
  }

  const level = value.level;

  if (typeof level !== "string") {
    return {
      valid: false,
      reason: "level is required",
    };
  }

  if (!LOG_LEVELS.includes(level as typeof LOG_LEVELS[number])) {
    return {
      valid: false,
      reason: `invalid level: '${level}'`,
    };
  }

  const service = value.service;

  if (typeof service !== "string" || service.trim() === "") {
    return {
      valid: false,
      reason: "service must be a non-empty string",
    };
  }

  if (containsNullCharacter(service)) {
    return {
      valid: false,
      reason: "service must not contain NUL characters",
    };
  }

  const message = value.message;

  if (typeof message !== "string" || message.trim() === "") {
    return {
      valid: false,
      reason: "message must be a non-empty string",
    };
  }


  if (containsNullCharacter(message)) {
    return {
      valid: false,
      reason: "message must not contain NUL characters",
    };
  }
  const attributes = value.attributes;

  if (attributes !== undefined && !isValidAttributes(attributes)) {
    return {
      valid: false,
      reason: "attributes must be a flat object with string, number, or boolean values",
    };
  }


  if (
    attributes !== undefined &&
    Object.values(attributes).some(
      (attribute) =>
        typeof attribute === "string" && containsNullCharacter(attribute),
    )
  ) {
    return {
      valid: false,
      reason: "attribute values must not contain NUL characters",
    };
  }
  return {
    valid: true,
    log: {
      timestamp,
      level: level as LogEntry["level"],
      service,
      message,
      attributes: attributes ?? {},
    },
  };
}
