export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export type LogAttributes = Record<string, string | number | boolean>;

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

export interface LogQuery {
  service?: string;
  level?: LogLevel;
  since?: Date;
  until?: Date;
  message?: string;
  attributes?: Record<string, string>;
  limit: number;
  cursor?: {
    timestamp: Date;
    id: string;
  };
}

export interface AggregateQuery {
  since: Date;
  until: Date;
  bucket: "1m" | "5m" | "1h" | "1d";
  groupBy?: "service" | "level";
  service?: string;
  level?: LogLevel;
  message?: string;
  attributes?: Record<string, string>;
}