import { describe, expect, it, vi } from "vitest";
import { deleteExpiredLogs } from "../src/services/retention.service.js";

describe("deleteExpiredLogs", () => {
  it("deletes in bounded batches until a partial batch is reached", async () => {
    const deleteBatch = vi.fn()
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(2);

    const result = await deleteExpiredLogs({
      cutoff: new Date("2026-08-01T00:00:00.000Z"),
      batchSize: 3,
      maxBatches: 10,
      deleteBatch,
    });

    expect(result).toEqual({
      deleted: 5,
      batches: 2,
      capped: false,
    });
    expect(deleteBatch).toHaveBeenCalledTimes(2);
  });

  it("caps a cleanup run to protect ingestion workloads", async () => {
    const deleteBatch = vi.fn().mockResolvedValue(2);

    const result = await deleteExpiredLogs({
      batchSize: 2,
      maxBatches: 2,
      deleteBatch,
    });

    expect(result).toEqual({
      deleted: 4,
      batches: 2,
      capped: true,
    });
  });
});
