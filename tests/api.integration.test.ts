import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db/index.js";
import { logs } from "../src/db/schema.js";
import { insertLogs } from "../src/repositories/logs.repository.js";
import { buildApp } from "../src/server/app.js";
import type { LogEntry } from "../src/types/log.types.js";

const app = buildApp();
const baseTimestamp = "2020-08-09T20:00:00.000Z";

function log(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    timestamp: baseTimestamp,
    level: "info",
    service: "auth",
    message: "login successful",
    attributes: {},
    ...overrides,
  };
}

async function getJson<T>(url: string) {
  const response = await app.inject({ method: "GET", url });
  return { response, body: response.json() as T };
}

beforeAll(async () => {
  await db.delete(logs);
});

beforeEach(async () => {
  await db.delete(logs);
});

describe("HTTP contract", () => {
  it("reports health when PostgreSQL is reachable", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("ingests valid batches and partially rejects invalid entries", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/logs",
      payload: {
        logs: [
          log(),
          { ...log(), timestamp: "not-a-timestamp" },
          log({ service: "checkout", message: "payment declined" }),
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      accepted: 2,
      rejected: [{ index: 1, reason: "invalid timestamp" }],
    });
  });

  it("preserves COPY text special characters and rejects NUL values per entry", async () => {
    const service = "checkout\\\\N\tquoted\"\ncarriage\r??";
    const message = "payment \"declined\"\\retry\tline one\nline two\r???";
    const attributes = {
      quoted: "\"value\"",
      slash: "a\\b",
      whitespace: "tab\tnewline\ncarriage\r",
      unicode: "????? ??",
    };

    const response = await app.inject({
      method: "POST",
      url: "/logs",
      payload: {
        logs: [
          log({ service, message, attributes }),
          log({ message: "contains\0nul" }),
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      accepted: 1,
      rejected: [{ index: 1, reason: "message must not contain NUL characters" }],
    });

    const result = await getJson<{ logs: Array<LogEntry> }>(
      `/logs?service=${encodeURIComponent(service)}`,
    );

    expect(result.response.statusCode).toBe(200);
    expect(result.body.logs).toHaveLength(1);
    expect(result.body.logs[0]).toMatchObject({ service, message, attributes });

  });
  it("returns 400 for invalid ingestion bodies and malformed JSON", async () => {
    const invalidCases = [
      {},
      { logs: [log({ level: "trace" as LogEntry["level"] })] },
      { logs: [log({ timestamp: new Date(Date.now() + 10 * 60 * 1_000).toISOString() })] },
      { logs: [log({ service: " " })] },
      { logs: [log({ message: "" })] },
      { logs: [{ ...log(), attributes: { nested: { value: "no" } } }] },
      { logs: [{ ...log(), attributes: { array: ["no"] } }] },
    ];

    for (const payload of invalidCases) {
      const response = await app.inject({ method: "POST", url: "/logs", payload });
      expect(response.statusCode).toBe(400);
    }

    const malformed = await app.inject({
      method: "POST",
      url: "/logs",
      headers: { "content-type": "application/json" },
      payload: '{"logs":',
    });

    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toEqual({ error: "malformed JSON body" });
  });

  it("filters attributes by their string representation and combines filters", async () => {
    await insertLogs([
      log({
        service: "checkout",
        level: "error",
        attributes: { user_id: "42", retries: 3, active: true },
      }),
      log({
        service: "checkout",
        level: "info",
        attributes: { user_id: "42", retries: 2, active: false },
      }),
      log({
        service: "auth",
        level: "error",
        attributes: { user_id: "99", retries: 3, active: true },
      }),
    ]);

    const { response, body } = await getJson<{ logs: Array<{ attributes: LogEntry["attributes"] }> }>(
      "/logs?attr.user_id=42&attr.retries=3&attr.active=true&service=checkout&level=error&since=2020-08-09T19%3A00%3A00.000Z&until=2020-08-09T21%3A00%3A00.000Z",
    );

    expect(response.statusCode).toBe(200);
    expect(body.logs).toHaveLength(1);
    expect(body.logs[0]?.attributes).toEqual({ user_id: "42", retries: 3, active: true });
  });

  it("applies time bounds, literal message search, and limit validation", async () => {
    await insertLogs([
      log({ timestamp: "2020-08-09T19:59:59.000Z", message: "before" }),
      log({ timestamp: "2020-08-09T20:00:00.000Z", message: "100% complete" }),
      log({ timestamp: "2020-08-09T20:30:00.000Z", message: "100x complete" }),
      log({ timestamp: "2020-08-09T21:00:00.000Z", message: "after" }),
    ]);

    const { body } = await getJson<{ logs: Array<{ message: string }> }>(
      "/logs?since=2020-08-09T20%3A00%3A00.000Z&until=2020-08-09T21%3A00%3A00.000Z&q=100%25",
    );

    expect(body.logs.map((entry) => entry.message)).toEqual(["100% complete"]);

    for (const url of [
      "/logs?limit=0",
      "/logs?limit=-1",
      "/logs?limit=1001",
      "/logs?limit=abc",
      "/logs?since=2020-08-09T20%3A00%3A00.000Z&until=2020-08-09T20%3A00%3A00.000Z",
      "/logs?since=not-a-date",
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toHaveProperty("error");
    }
  });

  it("paginates deterministically when timestamps are equal", async () => {
    await insertLogs([
      log({ message: "first" }),
      log({ message: "second" }),
      log({ message: "third" }),
      log({ timestamp: "2020-08-09T19:59:59.000Z", message: "fourth" }),
    ]);

    const first = await getJson<{ logs: Array<{ id: string }>; next_cursor: string | null }>("/logs?limit=2");
    const second = await getJson<{ logs: Array<{ id: string }>; next_cursor: string | null }>(
      `/logs?limit=2&cursor=${encodeURIComponent(first.body.next_cursor!)}`,
    );

    expect(first.body.logs).toHaveLength(2);
    expect(second.body.logs).toHaveLength(2);
    expect(new Set([...first.body.logs, ...second.body.logs].map((entry) => entry.id)).size).toBe(4);
    expect(second.body.next_cursor).toBeNull();

    const invalidCursors = [
      "not-a-cursor",
      Buffer.from(JSON.stringify({ timestamp: "not-a-date", id: "invalid" })).toString("base64url"),
      Buffer.from(JSON.stringify({ timestamp: baseTimestamp, id: "invalid" })).toString("base64url"),
    ];

    for (const cursor of invalidCursors) {
      const response = await app.inject({ method: "GET", url: `/logs?cursor=${cursor}` });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "invalid cursor" });
    }
  });

  it("aggregates all buckets in UTC and validates aggregation input", async () => {
    await insertLogs([
      log({ timestamp: "2020-08-09T20:01:00.000Z", service: "checkout", level: "error", attributes: { active: true } }),
      log({ timestamp: "2020-08-09T20:04:00.000Z", service: "checkout", level: "error", attributes: { active: true } }),
      log({ timestamp: "2020-08-09T20:06:00.000Z", service: "auth", level: "info", attributes: { active: false } }),
    ]);

    for (const bucket of ["1m", "5m", "1h", "1d"]) {
      const { response, body } = await getJson<{ buckets: Array<{ start: string; count: number; group: string | null }> }>(
        `/logs/aggregate?since=2020-08-09T20%3A00%3A00.000Z&until=2020-08-09T21%3A00%3A00.000Z&bucket=${bucket}&attr.active=true&service=checkout&group_by=level`,
      );

      expect(response.statusCode).toBe(200);
      expect(body.buckets).toHaveLength(bucket === "1m" ? 2 : bucket === "5m" ? 1 : 1);
      expect(body.buckets.every((entry) => entry.group === "error" && entry.count > 0)).toBe(true);
      expect(body.buckets.every((entry) => entry.start.endsWith("Z"))).toBe(true);
    }

    for (const url of [
      "/logs/aggregate?since=2020-08-09T20%3A00%3A00.000Z&until=2020-08-09T20%3A00%3A00.000Z&bucket=1h",
      "/logs/aggregate?since=2020-08-09T20%3A00%3A00.000Z&until=2020-08-09T21%3A00%3A00.000Z&bucket=2h",
      "/logs/aggregate?since=2020-08-09T20%3A00%3A00.000Z&until=2020-08-09T21%3A00%3A00.000Z&bucket=1h&group_by=region",
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toHaveProperty("error");
    }
  });
});
