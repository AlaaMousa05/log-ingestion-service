import {
  BUCKET_SIZES,
  GROUP_BY_FIELDS,
  LOG_LEVELS,
  type AggregateQuery,
  type AttributeFilters,
  type BucketSize,
  type GroupByField,
  type LogLevel,
  type LogQuery,
} from "../types/log.types.js";
import { decodeCursor } from "../utils/cursor.js";
import { parseIsoTimestamp } from "../utils/timestamp.js";

/** Query parameters prefixed with this filter on a single log attribute: `?attr.user_id=42`. */
const ATTRIBUTE_PREFIX = "attr.";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1_000;

/**
 * Parsed query parameters, or the message to return with a 400. Controllers
 * translate this into a response; nothing in here knows about HTTP itself.
 */
export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/**
 * A query string after the single-value check: repeated parameters (which Fastify
 * surfaces as arrays) have already been rejected, so every value is a string.
 */
type RawQuery = Record<string, string | undefined>;

function ok<T>(value: T): ParseResult<T> {
  return { ok: true, value };
}

function invalid<T>(error: string): ParseResult<T> {
  return { ok: false, error };
}

/**
 * Rejects repeated query parameters. `?level=info&level=error` arrives as an
 * array, which no filter below is prepared to handle.
 */
function toSingleValueQuery(rawQuery: unknown): RawQuery | null {
  const query = rawQuery as Record<string, unknown>;

  if (Object.values(query).some((value) => value !== undefined && typeof value !== "string")) {
    return null;
  }

  return query as RawQuery;
}

/** Empty parameters (`?level=`) are treated as absent rather than as invalid input. */
function isPresent(value: string | undefined): value is string {
  return value !== undefined && value !== "";
}

function parseLevel(value: string | undefined): ParseResult<LogLevel | undefined> {
  if (!isPresent(value)) {
    return ok(undefined);
  }

  if (!LOG_LEVELS.includes(value as LogLevel)) {
    return invalid(`invalid level: '${value}'`);
  }

  return ok(value as LogLevel);
}

function parseAttributeFilters(query: RawQuery): AttributeFilters | null {
  const attributes: AttributeFilters = {};

  for (const [key, value] of Object.entries(query)) {
    if (!key.startsWith(ATTRIBUTE_PREFIX)) {
      continue;
    }

    const attributeKey = key.slice(ATTRIBUTE_PREFIX.length);

    if (!attributeKey || value === undefined) {
      return null;
    }

    attributes[attributeKey] = value;
  }

  return attributes;
}

function parseLimit(value: string | undefined): ParseResult<number> {
  const limit = value === undefined ? DEFAULT_LIMIT : Number(value);

  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return invalid("invalid limit");
  }

  return ok(limit);
}

function parseCursor(
  value: string,
): ParseResult<{ timestamp: Date; id: string }> {
  const decoded = decodeCursor(value);
  const timestamp = decoded ? parseIsoTimestamp(decoded.timestamp) : null;

  if (!decoded || !timestamp) {
    return invalid("invalid cursor");
  }

  return ok({ timestamp, id: decoded.id });
}

/**
 * Validates the GET /logs query string. `limit` is the caller's requested page
 * size; the pagination look-ahead is the controller's concern.
 */
export function parseLogQuery(rawQuery: unknown): ParseResult<LogQuery> {
  const query = toSingleValueQuery(rawQuery);

  if (!query) {
    return invalid("query parameters must be single string values");
  }

  const level = parseLevel(query.level);

  if (!level.ok) {
    return level;
  }

  const since = isPresent(query.since) ? parseIsoTimestamp(query.since) : undefined;

  if (isPresent(query.since) && !since) {
    return invalid("invalid since timestamp");
  }

  const until = isPresent(query.until) ? parseIsoTimestamp(query.until) : undefined;

  if (isPresent(query.until) && !until) {
    return invalid("invalid until timestamp");
  }

  if (since && until && until <= since) {
    return invalid("until must be after since");
  }

  const limit = parseLimit(query.limit);

  if (!limit.ok) {
    return limit;
  }

  let cursor: LogQuery["cursor"];

  if (isPresent(query.cursor)) {
    const parsed = parseCursor(query.cursor);

    if (!parsed.ok) {
      return parsed;
    }

    cursor = parsed.value;
  }

  const attributes = parseAttributeFilters(query);

  if (!attributes) {
    return invalid("invalid attribute filter");
  }

  return ok({
    ...(isPresent(query.service) && { service: query.service }),
    ...(level.value && { level: level.value }),
    ...(since && { since }),
    ...(until && { until }),
    ...(isPresent(query.q) && { message: query.q }),
    ...(Object.keys(attributes).length > 0 && { attributes }),
    ...(cursor && { cursor }),
    limit: limit.value,
  });
}

/** Validates the GET /logs/aggregate query string, where the time window is mandatory. */
export function parseAggregateQuery(rawQuery: unknown): ParseResult<AggregateQuery> {
  const query = toSingleValueQuery(rawQuery);

  if (!query) {
    return invalid("query parameters must be single string values");
  }

  if (!query.since || !query.until) {
    return invalid("since and until are required");
  }

  const level = parseLevel(query.level);

  if (!level.ok) {
    return level;
  }

  const since = parseIsoTimestamp(query.since);
  const until = parseIsoTimestamp(query.until);

  if (!since || !until) {
    return invalid("invalid timestamp");
  }

  if (until <= since) {
    return invalid("until must be after since");
  }

  const bucket = query.bucket;

  if (!BUCKET_SIZES.includes(bucket as BucketSize)) {
    return invalid("invalid bucket");
  }

  const groupBy = query.group_by;

  if (isPresent(groupBy) && !GROUP_BY_FIELDS.includes(groupBy as GroupByField)) {
    return invalid("invalid group_by");
  }

  const attributes = parseAttributeFilters(query);

  if (!attributes) {
    return invalid("invalid attribute filter");
  }

  return ok({
    since,
    until,
    bucket: bucket as BucketSize,
    ...(isPresent(query.service) && { service: query.service }),
    ...(level.value && { level: level.value }),
    ...(isPresent(query.q) && { message: query.q }),
    ...(Object.keys(attributes).length > 0 && { attributes }),
    ...(isPresent(groupBy) && { groupBy: groupBy as GroupByField }),
  });
}
