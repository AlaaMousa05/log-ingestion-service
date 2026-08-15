import type { LogEntry } from "../types/log.types.js";

interface PendingSubmission {
  entries: LogEntry[];
  resolve: (accepted: number) => void;
  reject: (error: unknown) => void;
}

/**
 * Coalesces already-validated rows from concurrent POST /logs requests into
 * fewer, larger COPY operations, instead of one COPY per request. Targets the
 * confirmed bottleneck directly: Postgres CPU sits pinned at 100-107% in
 * every official stage regardless of pool/timeout config, meaning the cost is
 * dominated by per-operation overhead (transaction/COPY setup, WAL/fsync,
 * connection turnover), not by row count -- merging N small COPYs into one
 * larger COPY reduces operation count without changing total row count.
 *
 * Per-entry validation (accept/reject/index/reason) happens entirely upstream
 * in logs.service.ts, before anything reaches this class -- coalescing only
 * ever affects the DB write of rows already known to be valid. It never
 * changes what gets accepted or rejected, only how the accepted rows are
 * physically written.
 *
 * Correctness invariants:
 *  - A request's promise resolves only after its rows are durably committed
 *    as part of the shared COPY that window flushed -- never before (the
 *    write always happens, and always completes, before any resolve/reject
 *    in that window fires).
 *  - One window's outcome never touches another window's requests: each
 *    flush takes its own independent batch of pending submissions and their
 *    own promises; a later request that arrives after flush() has already
 *    started building the next window is entirely unaffected by the
 *    in-flight window's success or failure.
 *  - If the shared write fails, every request coalesced into that specific
 *    window is rejected with the same error (there is no partial-success
 *    concept within a single COPY), which the existing pool-exhaustion error
 *    classifier in server/app.ts turns into a 503 exactly as it would for an
 *    uncoalesced request hitting the same failure.
 */
export class IngestCoalescer {
  private pending: PendingSubmission[] = [];
  private pendingEntryCount = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly windowMs: number,
    private readonly maxBatchEntries: number,
    private readonly write: (entries: LogEntry[]) => Promise<number>,
  ) {}

  submit(entries: LogEntry[]): Promise<number> {
    return new Promise((resolve, reject) => {
      this.pending.push({ entries, resolve, reject });
      this.pendingEntryCount += entries.length;

      if (this.pendingEntryCount >= this.maxBatchEntries) {
        this.flush();
        return;
      }

      this.timer ??= setTimeout(() => this.flush(), this.windowMs);
    });
  }

  private flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.pending.length === 0) {
      return;
    }

    // Detach this window's batch immediately so any request arriving while
    // the write below is in flight starts a fresh window instead of racing
    // to join one that's already being written.
    const batch = this.pending;
    this.pending = [];
    this.pendingEntryCount = 0;

    const merged = batch.flatMap((item) => item.entries);

    this.write(merged)
      .then(() => {
        for (const item of batch) {
          item.resolve(item.entries.length);
        }
      })
      .catch((error: unknown) => {
        for (const item of batch) {
          item.reject(error);
        }
      });
  }
}
