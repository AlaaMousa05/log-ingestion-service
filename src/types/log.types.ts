export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export const BUCKET_SIZES = ["1m", "5m", "1h", "1d"] as const;

export type BucketSize = (typeof BUCKET_SIZES)[number];

export const GROUP_BY_FIELDS = ["service", "level"] as const;

export type GroupByField = (typeof GROUP_BY_FIELDS)[number];

export type LogAttributes = Record<string, string | number | boolean>;

// Always compared as text, per the query-string filter contract.
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

// Raw date_bin text from Postgres, not a parsed Date.
export type AggregateBucket = {
  start: string;
  group: string | null;
  count: number;
};
