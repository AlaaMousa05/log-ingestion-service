import { env } from "../config/env.js";
import { deleteExpiredLogsBatch } from "../repositories/retention.repository.js";

export interface RetentionResult {
  deleted: number;
  batches: number;
  capped: boolean;
}

export interface RetentionOptions {
  cutoff?: Date;
  batchSize?: number;
  maxBatches?: number;
  deleteBatch?: (cutoff: Date, batchSize: number) => Promise<number>;
}

export function retentionCutoff(now = new Date()): Date {
  return new Date(now.getTime() - env.retentionDays * 24 * 60 * 60 * 1_000);
}


export async function deleteExpiredLogs(
  options: RetentionOptions = {},
): Promise<RetentionResult> {
  const cutoff = options.cutoff ?? retentionCutoff();
  const batchSize = options.batchSize ?? env.retentionBatchSize;
  const maxBatches = options.maxBatches ?? env.retentionMaxBatches;
  const deleteBatch = options.deleteBatch ?? deleteExpiredLogsBatch;

  let deleted = 0;
  let batches = 0;

  while (batches < maxBatches) {
    const deletedInBatch = await deleteBatch(cutoff, batchSize);

    if (deletedInBatch === 0) {
      break;
    }

    deleted += deletedInBatch;
    batches += 1;

    if (deletedInBatch < batchSize) {
      break;
    }
  }

  return {
    deleted,
    batches,
    capped: batches === maxBatches,
  };
}
