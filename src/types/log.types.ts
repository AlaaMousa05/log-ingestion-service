export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/** Time-bucket widths accepted by GET /logs/aggregate. */
export const BUCKET_SIZES = ["1m", "5m", "1h", "1d"] as const;

export type BucketSize = (typeof BUCKET_SIZES)[number];

/** Dimensions GET /logs/aggregate can break its buckets down by. */
export const GROUP_BY_FIELDS = ["service", "level"] as const;

export type GroupByField = (typeof GROUP_BY_FIELDS)[number];

export type LogAttributes = Record<string, string | number | boolean>;

/**
 * Attribute filters arrive from the query string, so every value is compared as
 * text against the `attributes_text` column rather than against typed JSON.
 */
export type AttributeFilters = Record<string, string>;

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  service: string;
  message: string;
  attributes?: LogAttributes;
}

export interface LogsRequest {
  logs: unknown[];
}

export interface RejectedLog {
  index: number;
  reason: string;
}

/**
 * Outcome of an ingestion attempt. `error` means the request body itself was
 * unusable; the other shape reports per-entry results, with `allRejected` set
 * when nothing survived validation and therefore nothing was written.
 */
export type IngestResult =
  | { error: string }
  | { accepted: number; rejected: RejectedLog[]; allRejected: boolean };

export interface LogQuery {
  service?: string;
  level?: LogLevel;
  since?: Date;
  until?: Date;
  message?: string;
  attributes?: AttributeFilters;
  limit: number;
  cursor?: {
    timestamp: Date;
    id: string;
  };
}

export interface AggregateQuery {
  since: Date;
  until: Date;
  bucket: BucketSize;
  groupBy?: GroupByField;
  service?: string;
  level?: LogLevel;
  message?: string;
  attributes?: AttributeFilters;
}

/**
 * One aggregation row as PostgreSQL returns it. `start` is the raw timestamptz
 * text emitted by `date_bin` — the driver applies no type mapping to computed
 * expressions, so it is a string here, not a Date.
 */
export type AggregateBucket = {
  start: string;
  group: string | null;
  count: number;
};
