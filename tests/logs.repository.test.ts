import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "../src/db/index.js";
import { logs, logsRollup } from "../src/db/schema.js";
import {
  aggregateLogs,
  findLogs,
  insertLogs,
} from "../src/repositories/logs.repository.js";

/**
 * `logs_rollup` is derived from `logs` and is kept in step by whatever writes
 * them (ingestion writes both in one transaction; retention prunes both). A
 * test that empties `logs` directly bypasses both, so it has to clear the
 * derived counts too or the next aggregation sees the previous test's rows.
 */
async function resetLogs() {
  await db.delete(logs);
  await db.delete(logsRollup);
}

beforeAll(resetLogs);

beforeEach(resetLogs);

afterAll(resetLogs);

describe("insertLogs", () => {
  it("returns 0 for an empty array", async () => {
    const result = await insertLogs([]);

    expect(result).toBe(0);
  });

  it("inserts multiple logs", async () => {
    const result = await insertLogs([
      {
        timestamp: "2026-08-09T20:00:00.000Z",
        level: "info",
        service: "auth",
        message: "login successful",
        attributes: {
          user_id: "42",
          region: "eu-west",
        },
      },
      {
        timestamp: "2026-08-09T20:01:00.000Z",
        level: "error",
        service: "payments",
        message: "payment failed",
        attributes: {
          user_id: "43",
          retries: 2,
        },
      },
    ]);

    expect(result).toBe(2);

    const rows = await db.select().from(logs);

    expect(rows).toHaveLength(2);
    expect(rows[0]?.service).toBeDefined();
  });
});

describe("findLogs", () => {
  beforeEach(async () => {
    await insertLogs([
      {
        timestamp: "2026-08-09T20:00:00.000Z",
        level: "error",
        service: "checkout",
        message: "payment declined",
        attributes: {
          user_id: "42",
          region: "eu-west",
        },
      },
      {
        timestamp: "2026-08-09T20:01:00.000Z",
        level: "info",
        service: "auth",
        message: "login successful",
        attributes: {
          user_id: "43",
          region: "eu-west",
        },
      },
      {
        timestamp: "2026-08-09T20:02:00.000Z",
        level: "error",
        service: "payments",
        message: "payment timeout",
        attributes: {
          user_id: "42",
          region: "us-east",
        },
      },
    ]);
  });

  it("returns logs ordered by timestamp descending", async () => {
    const result = await findLogs({
      limit: 10,
    });

    expect(result).toHaveLength(3);

    expect(result[0]?.timestamp.toISOString()).toBe(
      "2026-08-09T20:02:00.000Z",
    );

    expect(result[1]?.timestamp.toISOString()).toBe(
      "2026-08-09T20:01:00.000Z",
    );

    expect(result[2]?.timestamp.toISOString()).toBe(
      "2026-08-09T20:00:00.000Z",
    );
  });

  it("filters by service", async () => {
    const result = await findLogs({
      service: "checkout",
      limit: 10,
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.service).toBe("checkout");
  });

  it("filters by level", async () => {
    const result = await findLogs({
      level: "error",
      limit: 10,
    });

    expect(result).toHaveLength(2);
    expect(result.every((log) => log.level === "error")).toBe(true);
  });

  it("filters by message case-insensitively", async () => {
    const result = await findLogs({
      message: "PAYMENT",
      limit: 10,
    });

    expect(result).toHaveLength(2);
  });

  it("filters by attributes", async () => {
    const result = await findLogs({
      attributes: {
        user_id: "42",
      },
      limit: 10,
    });

    expect(result).toHaveLength(2);
    expect(
      result.every((log) => log.attributes.user_id === "42"),
    ).toBe(true);
  });

  it("filters by since and until", async () => {
    const result = await findLogs({
      since: new Date("2026-08-09T20:01:00.000Z"),
      until: new Date("2026-08-09T20:02:00.000Z"),
      limit: 10,
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.message).toBe("login successful");
  });

  it("returns exactly the requested limit", async () => {
    const result = await findLogs({
      limit: 2,
    });

    expect(result).toHaveLength(2);
  });
});

describe("aggregateLogs", () => {
  beforeEach(async () => {
    await insertLogs([
      {
        timestamp: "2026-08-09T20:10:00.000Z",
        level: "error",
        service: "checkout",
        message: "payment declined",
      },
      {
        timestamp: "2026-08-09T20:20:00.000Z",
        level: "error",
        service: "checkout",
        message: "payment timeout",
      },
      {
        timestamp: "2026-08-09T20:30:00.000Z",
        level: "info",
        service: "auth",
        message: "login successful",
      },
    ]);
  });

  it("aggregates logs into hourly buckets", async () => {
    const result = await aggregateLogs({
      since: new Date("2026-08-09T20:00:00.000Z"),
      until: new Date("2026-08-09T21:00:00.000Z"),
      bucket: "1h",
    });

    expect(result).toHaveLength(1);
    expect(Number(result[0]?.count)).toBe(3);
  });

  it("groups by service", async () => {
    const result = await aggregateLogs({
      since: new Date("2026-08-09T20:00:00.000Z"),
      until: new Date("2026-08-09T21:00:00.000Z"),
      bucket: "1h",
      groupBy: "service",
    });

    expect(result).toHaveLength(2);

    const groups = result.map((row) => row.group);

    expect(groups).toContain("auth");
    expect(groups).toContain("checkout");
  });

  it("groups by level", async () => {
    const result = await aggregateLogs({
      since: new Date("2026-08-09T20:00:00.000Z"),
      until: new Date("2026-08-09T21:00:00.000Z"),
      bucket: "1h",
      groupBy: "level",
    });

    expect(result).toHaveLength(2);

    const groups = result.map((row) => row.group);

    expect(groups).toContain("error");
    expect(groups).toContain("info");
  });

  it("filters aggregation by service", async () => {
    const result = await aggregateLogs({
      since: new Date("2026-08-09T20:00:00.000Z"),
      until: new Date("2026-08-09T21:00:00.000Z"),
      bucket: "1h",
      service: "checkout",
    });

    expect(result).toHaveLength(1);
    expect(Number(result[0]?.count)).toBe(2);
  });
});
