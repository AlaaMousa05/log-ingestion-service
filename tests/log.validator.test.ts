import { describe, expect, it } from "vitest";
import { validateLogEntry } from "../src/validators/log.validator.js";

describe("validateLogEntry", () => {
  it("accepts a valid log", () => {
    const result = validateLogEntry({
      timestamp: "2026-08-09T20:00:00.000Z",
      level: "error",
      service: "checkout",
      message: "payment declined",
      attributes: {
        user_id: "42",
        retries: 3,
        production: true,
      },
    });

    expect(result.valid).toBe(true);

    if (result.valid) {
      expect(result.log.level).toBe("error");
      expect(result.log.service).toBe("checkout");
    }
  });

  it("rejects a non-object log", () => {
    const result = validateLogEntry(null);

    expect(result).toEqual({
      valid: false,
      reason: "log entry must be an object",
    });
  });

  it("rejects an invalid timestamp", () => {
    const result = validateLogEntry({
      timestamp: "not-a-date",
      level: "error",
      service: "auth",
      message: "test",
    });

    expect(result).toEqual({
      valid: false,
      reason: "invalid timestamp",
    });
  });

  it("rejects an invalid level", () => {
    const result = validateLogEntry({
      timestamp: "2026-08-09T20:00:00.000Z",
      level: "critical",
      service: "auth",
      message: "test",
    });

    expect(result).toEqual({
      valid: false,
      reason: "invalid level: 'critical'",
    });
  });

  it("rejects an empty service", () => {
    const result = validateLogEntry({
      timestamp: "2026-08-09T20:00:00.000Z",
      level: "info",
      service: "   ",
      message: "test",
    });

    expect(result).toEqual({
      valid: false,
      reason: "service must be a non-empty string",
    });
  });

  it("rejects an empty message", () => {
    const result = validateLogEntry({
      timestamp: "2026-08-09T20:00:00.000Z",
      level: "info",
      service: "auth",
      message: "",
    });

    expect(result).toEqual({
      valid: false,
      reason: "message must be a non-empty string",
    });
  });

  it("rejects nested attributes", () => {
    const result = validateLogEntry({
      timestamp: "2026-08-09T20:00:00.000Z",
      level: "info",
      service: "auth",
      message: "test",
      attributes: {
        user: {
          id: 42,
        },
      },
    });

    expect(result).toEqual({
      valid: false,
      reason:
        "attributes must be a flat object with string, number, or boolean values",
    });
  });

  it("rejects non-finite numeric attributes", () => {
    const result = validateLogEntry({
      timestamp: "2026-08-09T20:00:00.000Z",
      level: "info",
      service: "auth",
      message: "test",
      attributes: {
        value: Infinity,
      },
    });

    expect(result).toEqual({
      valid: false,
      reason:
        "attributes must be a flat object with string, number, or boolean values",
    });
  });
});