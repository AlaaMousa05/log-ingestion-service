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