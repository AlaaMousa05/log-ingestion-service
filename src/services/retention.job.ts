import { deleteExpiredLogs } from "./retention.service.js";

const RETENTION_INTERVAL_MS = 60 * 60 * 1_000;

export interface RetentionJob {
  stop: () => void;
}

export function startRetentionJob(): RetentionJob {
  let running = false;

  const run = async () => {
    if (running) {
      console.warn("Retention cleanup skipped because the previous run is still active");
      return;
    }

    running = true;

    try {
      const result = await deleteExpiredLogs();
      console.log(
        `Retention cleanup deleted ${result.deleted} logs in ${result.batches} batch(es)${result.capped ? "; batch cap reached" : ""}`,
      );
    } catch (error) {
      console.error("Retention job failed", error);
    } finally {
      running = false;
    }
  };

  void run();
  const timer = setInterval(() => void run(), RETENTION_INTERVAL_MS);
  timer.unref();

  return {
    stop: () => clearInterval(timer),
  };
}
