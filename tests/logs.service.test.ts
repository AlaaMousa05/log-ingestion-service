import { beforeEach, describe, expect, it, vi } from "vitest";

const { insertLogsMock } = vi.hoisted(() => ({
  insertLogsMock: vi.fn(),
}));

vi.mock("../src/repositories/logs.repository.js", () => ({
  insertLogs: insertLogsMock,
}));

import { ingestLogs } from "../src/services/logs.service.js";
describe("ingestLogs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects a request without a logs array", async () => {
    const result = await ingestLogs({});

    expect(result).toEqual({
      error: "request body must contain a logs array",
    });

    expect(insertLogsMock).not.toHaveBeenCalled();
  });

  it("accepts valid logs", async () => {
    insertLogsMock.mockResolvedValue(2);

    const result = await ingestLogs({
      logs: [
        {
          timestamp: "2026-08-09T20:00:00.000Z",
          level: "info",
          service: "auth",
          message: "user logged in",
        },
        {
          timestamp: "2026-08-09T20:01:00.000Z",
          level: "error",
          service: "checkout",
          message: "payment failed",
        },
      ],
    });

    expect(result).toEqual({
      accepted: 2,
      rejected: [],
      allRejected: false,
    });

    expect(insertLogsMock).toHaveBeenCalledTimes(1);
  });

  it("partially accepts valid logs and rejects invalid logs", async () => {
    insertLogsMock.mockResolvedValue(1);

    const result = await ingestLogs({
      logs: [
        {
          timestamp: "2026-08-09T20:00:00.000Z",
          level: "info",
          service: "auth",
          message: "valid log",
        },
        {
          timestamp: "not-a-date",
          level: "error",
          service: "auth",
          message: "invalid timestamp",
        },
      ],
    });

    expect(result).toEqual({
      accepted: 1,
      rejected: [
        {
          index: 1,
          reason: "invalid timestamp",
        },
      ],
      allRejected: false,
    });

    expect(insertLogsMock).toHaveBeenCalledTimes(1);
  });

  it("returns allRejected when every log is invalid", async () => {
    const result = await ingestLogs({
      logs: [
        {
          timestamp: "not-a-date",
          level: "error",
          service: "auth",
          message: "bad timestamp",
        },
        {
          timestamp: "2026-08-09T20:00:00.000Z",
          level: "critical",
          service: "auth",
          message: "bad level",
        },
      ],
    });

    expect(result).toEqual({
      accepted: 0,
      rejected: [
        {
          index: 0,
          reason: "invalid timestamp",
        },
        {
          index: 1,
          reason: "invalid level: 'critical'",
        },
      ],
      allRejected: true,
    });

    expect(insertLogsMock).not.toHaveBeenCalled();
  });

  it("passes valid logs to the repository", async () => {
    insertLogsMock.mockResolvedValue(1);

    const validLog = {
      timestamp: "2026-08-09T20:00:00.000Z",
      level: "info",
      service: "auth",
      message: "user logged in",
      attributes: {
        user_id: "42",
        retries: 2,
      },
    };

    await ingestLogs({
      logs: [validLog],
    });

    expect(insertLogsMock).toHaveBeenCalledWith([
      {
        timestamp: "2026-08-09T20:00:00.000Z",
        level: "info",
        service: "auth",
        message: "user logged in",
        attributes: {
          user_id: "42",
          retries: 2,
        },
      },
    ]);
  });
});