import {
  LOG_LEVELS,
  type LogAttributes,
  type LogEntry,
  type LogLevel,
} from "../types/log.types.js";
import { parseIsoTimestamp } from "../utils/timestamp.js";

/**
 * Clock skew between the caller and this service is expected, so timestamps are
 * allowed to run slightly ahead of now before being rejected as bogus.
 */
const MAX_FUTURE_MS = 5 * 60 * 1000;

export type ValidationResult =
  | { valid: true; log: LogEntry }
  | { valid: false; reason: string };

function invalid(reason: string): ValidationResult {
  return { valid: false, reason };
}

/** PostgreSQL text columns cannot store NUL, so entries carrying one are rejected. */
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

export function validateLogEntry(value: unknown): ValidationResult {
  if (!isPlainObject(value)) {
    return invalid("log entry must be an object");
  }

  const timestamp = value.timestamp;

  if (typeof timestamp !== "string") {
    return invalid("timestamp is required");
  }

  const parsedTimestamp = parseIsoTimestamp(timestamp);

  if (!parsedTimestamp) {
    return invalid("invalid timestamp");
  }

  if (parsedTimestamp.getTime() >= Date.now() + MAX_FUTURE_MS) {
    return invalid("timestamp cannot be more than five minutes in the future");
  }

  const level = value.level;

  if (typeof level !== "string") {
    return invalid("level is required");
  }

  if (!LOG_LEVELS.includes(level as LogLevel)) {
    return invalid(`invalid level: '${level}'`);
  }

  const service = value.service;

  if (typeof service !== "string" || service.trim() === "") {
    return invalid("service must be a non-empty string");
  }

  if (containsNullCharacter(service)) {
    return invalid("service must not contain NUL characters");
  }

  const message = value.message;

  if (typeof message !== "string" || message.trim() === "") {
    return invalid("message must be a non-empty string");
  }

  if (containsNullCharacter(message)) {
    return invalid("message must not contain NUL characters");
  }

  const attributes = value.attributes;

  if (attributes !== undefined && !isValidAttributes(attributes)) {
    return invalid(
      "attributes must be a flat object with string, number, or boolean values",
    );
  }

  if (
    attributes !== undefined &&
    Object.values(attributes).some(
      (attribute) =>
        typeof attribute === "string" && containsNullCharacter(attribute),
    )
  ) {
    return invalid("attribute values must not contain NUL characters");
  }

  return {
    valid: true,
    log: {
      timestamp,
      level: level as LogLevel,
      service,
      message,
      attributes: attributes ?? {},
    },
  };
}
