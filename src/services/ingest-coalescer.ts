import type { LogEntry } from "../types/log.types.js";

interface PendingSubmission {
  entries: LogEntry[];
  resolve: (accepted: number) => void;
  reject: (error: unknown) => void;
}

// Merges concurrent batches into one shared COPY.
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

    // Detach the window so late arrivals start fresh.
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
