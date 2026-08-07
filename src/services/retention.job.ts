import { deleteExpiredLogs } from "./retention.service.js";


export function startRetentionJob() {
  const interval =
    1000 * 60 * 60; // every hour


  setInterval(async () => {
    try {
      await deleteExpiredLogs();
    } catch (error) {
      console.error(
        "Retention job failed",
        error,
      );
    }
  }, interval);


  console.log(
    "Retention job started",
  );
}