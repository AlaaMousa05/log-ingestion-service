import { describe, expect, it, vi } from "vitest";
import { IngestCoalescer } from "../src/services/ingest-coalescer.js";
import type { LogEntry } from "../src/types/log.types.js";

function makeEntries(count: number, tag: string): LogEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    timestamp: "2026-08-16T00:00:00.000Z",
    level: "info",
    service: tag,
    message: `${tag}-${i}`,
  }));
}

describe("IngestCoalescer", () => {
  it("merges concurrent submissions within the window into a single write call", async () => {
    const write = vi.fn().mockImplementation(async (entries: LogEntry[]) => entries.length);
    const coalescer = new IngestCoalescer(20, 10_000, write);

    const a = makeEntries(3, "a");
    const b = makeEntries(2, "b");
    const c = makeEntries(4, "c");

    const [acceptedA, acceptedB, acceptedC] = await Promise.all([
      coalescer.submit(a),
      coalescer.submit(b),
      coalescer.submit(c),
    ]);

    expect(write).toHaveBeenCalledTimes(1);
    const mergedArg = write.mock.calls[0]?.[0] as LogEntry[];
    expect(mergedArg).toHaveLength(9);
    // Order preserved: a's rows, then b's, then c's, matching submission order.
    expect(mergedArg.map((e) => e.message)).toEqual([...a, ...b, ...c].map((e) => e.message));

    // Each caller gets back its OWN count, not the merged total.
    expect(acceptedA).toBe(3);
    expect(acceptedB).toBe(2);
    expect(acceptedC).toBe(4);
  });

  it("resolves each caller only after the shared write durably completes", async () => {
    let writeResolved = false;
    const write = vi.fn().mockImplementation(async (entries: LogEntry[]) => {
      await new Promise((r) => setTimeout(r, 30));
      writeResolved = true;
      return entries.length;
    });
    const coalescer = new IngestCoalescer(10, 10_000, write);

    const result = await coalescer.submit(makeEntries(1, "x"));

    expect(writeResolved).toBe(true);
    expect(result).toBe(1);
  });

  it("rejects every request coalesced into a failing window with the same error", async () => {
    const boom = new Error("timeout exceeded when trying to connect");
    const write = vi.fn().mockRejectedValue(boom);
    const coalescer = new IngestCoalescer(15, 10_000, write);

    const results = await Promise.allSettled([
      coalescer.submit(makeEntries(1, "p")),
      coalescer.submit(makeEntries(1, "q")),
    ]);

    expect(results[0]?.status).toBe("rejected");
    expect(results[1]?.status).toBe("rejected");
    expect((results[0] as PromiseRejectedResult).reason).toBe(boom);
    expect((results[1] as PromiseRejectedResult).reason).toBe(boom);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("does not let one window's failure affect a later, independent window", async () => {
    const write = vi.fn()
      .mockRejectedValueOnce(new Error("first window fails"))
      .mockResolvedValueOnce(1);
    const coalescer = new IngestCoalescer(15, 10_000, write);

    const first = coalescer.submit(makeEntries(1, "fail-me"));
    await expect(first).rejects.toThrow("first window fails");

    // A fresh submission after the first window has already flushed and
    // settled must start (and succeed in) its own new window.
    const second = await coalescer.submit(makeEntries(1, "succeed-me"));
    expect(second).toBe(1);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("flushes early once a window accumulates maxBatchEntries, without waiting for the timer", async () => {
    const write = vi.fn().mockImplementation(async (entries: LogEntry[]) => entries.length);
    // windowMs is deliberately long; only the entry-count safety valve should
    // trigger this flush.
    const coalescer = new IngestCoalescer(5_000, 5, write);

    const start = Date.now();
    const result = await coalescer.submit(makeEntries(5, "big"));
    const elapsed = Date.now() - start;

    expect(result).toBe(5);
    expect(elapsed).toBeLessThan(200);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("never invokes write with an empty array from a flush with nothing pending", async () => {
    const write = vi.fn();
    const coalescer = new IngestCoalescer(10, 10_000, write);

    // No submissions at all -- give the (nonexistent) timer time to fire.
    await new Promise((r) => setTimeout(r, 30));
    void coalescer;

    expect(write).not.toHaveBeenCalled();
  });
});
