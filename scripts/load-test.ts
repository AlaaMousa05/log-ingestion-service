import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function positiveInteger(name: string, fallback: number): number {
  const value = process.env[name];

  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

const totalLogs = positiveInteger("TOTAL_LOGS", 1_000_000);
const batchSize = positiveInteger("BATCH_SIZE", 2_500);
const workers = positiveInteger("WORKERS", 6);
const url = process.env.LOG_SERVICE_URL ?? "http://localhost:8080";
const captureDockerStats = process.env.CAPTURE_DOCKER_STATS === "true";

const levels = ["debug", "info", "warn", "error"] as const;
const services = ["auth", "checkout", "payments", "orders"];
const monthMs = 30 * 24 * 60 * 60 * 1_000;

interface DockerSample {
  timestamp: string;
  container: string;
  cpu: string;
  memory: string;
}

const ingestionLatencies: number[] = [];
const aggregationLatencies: number[] = [];
const dockerSamples: DockerSample[] = [];
let accepted = 0;
let rejected = 0;
let failedRequests = 0;
let aggregationRequests = 0;
let aggregationErrors = 0;
let nextOffset = 0;
let keepAggregating = true;

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1);
  return sorted[index] ?? null;
}

function formatLatency(values: number[]) {
  return {
    count: values.length,
    min_ms: values.length ? Math.min(...values) : null,
    p50_ms: percentile(values, 0.5),
    p95_ms: percentile(values, 0.95),
    p99_ms: percentile(values, 0.99),
    max_ms: values.length ? Math.max(...values) : null,
  };
}

function createBatch(offset: number, size: number) {
  const now = Date.now();

  return Array.from({ length: size }, (_, index) => {
    const sequence = offset + index;

    return {
      // Spread the generated data across approximately one month, rather than
      // making adjacent sequence numbers only milliseconds apart.
      timestamp: new Date(
        now - Math.floor((sequence / totalLogs) * monthMs),
      ).toISOString(),
      level: levels[sequence % levels.length],
      service: services[sequence % services.length],
      message: `benchmark log ${sequence}`,
      attributes: {
        user_id: String(sequence % 10_000),
        region: sequence % 2 === 0 ? "eu-west" : "us-east",
        retries: sequence % 4,
        sampled: sequence % 2 === 0,
      },
    };
  });
}

async function ingestWorker() {
  while (true) {
    const offset = nextOffset;
    nextOffset += batchSize;

    if (offset >= totalLogs) {
      return;
    }

    const logs = createBatch(offset, Math.min(batchSize, totalLogs - offset));
    const startedAt = performance.now();

    try {
      const response = await fetch(`${url}/logs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ logs }),
      });
      const elapsed = performance.now() - startedAt;
      ingestionLatencies.push(elapsed);

      if (!response.ok) {
        failedRequests += 1;
        console.error(`Ingestion batch at ${offset} failed with HTTP ${response.status}`);
        continue;
      }

      const result = await response.json() as { accepted?: number; rejected?: unknown[] };
      accepted += result.accepted ?? 0;
      rejected += result.rejected?.length ?? 0;
    } catch (error) {
      failedRequests += 1;
      console.error(`Ingestion batch at ${offset} failed`, error);
    }
  }
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function aggregateDuringIngestion() {
  while (keepAggregating) {
    const startedAt = performance.now();

    try {
      const until = new Date();
      const since = new Date(until.getTime() - monthMs);
      const response = await fetch(
        `${url}/logs/aggregate?since=${encodeURIComponent(since.toISOString())}&until=${encodeURIComponent(until.toISOString())}&bucket=1h`,
      );
      aggregationLatencies.push(performance.now() - startedAt);
      aggregationRequests += 1;

      if (!response.ok) {
        aggregationErrors += 1;
      }
    } catch (error) {
      aggregationLatencies.push(performance.now() - startedAt);
      aggregationRequests += 1;
      aggregationErrors += 1;
      console.error("Aggregation request failed", error);
    }

    const remaining = 1_000 - (performance.now() - startedAt);
    await sleep(Math.max(0, remaining));
  }
}

async function captureStats() {
  try {
    const { stdout } = await execFileAsync("docker", [
      "stats",
      "--no-stream",
      "--format",
      "{{json .}}",
      "log-ingestion-app",
      "log-ingestion-postgres",
    ]);

    for (const line of stdout.trim().split("\n")) {
      if (!line) {
        continue;
      }

      const row = JSON.parse(line) as {
        Name: string;
        CPUPerc: string;
        MemUsage: string;
      };

      dockerSamples.push({
        timestamp: new Date().toISOString(),
        container: row.Name,
        cpu: row.CPUPerc,
        memory: row.MemUsage,
      });
    }
  } catch (error) {
    console.error("Unable to capture Docker resource statistics", error);
  }
}

console.log(JSON.stringify({
  event: "benchmark_started",
  total_logs: totalLogs,
  batch_size: batchSize,
  workers,
  url,
  capture_docker_stats: captureDockerStats,
}));

const startedAt = performance.now();
const aggregationTask = aggregateDuringIngestion();
const statsTimer = captureDockerStats
  ? setInterval(() => void captureStats(), 5_000)
  : undefined;

if (captureDockerStats) {
  await captureStats();
}

await Promise.all(Array.from({ length: workers }, () => ingestWorker()));
keepAggregating = false;
await aggregationTask;

if (statsTimer) {
  clearInterval(statsTimer);
  await captureStats();
}

const elapsedMs = performance.now() - startedAt;
const summary = {
  event: "benchmark_complete",
  requested_logs: totalLogs,
  accepted,
  rejected,
  failed_requests: failedRequests,
  dropped_logs: totalLogs - accepted - rejected,
  duration_ms: Math.round(elapsedMs),
  ingestion_logs_per_second: Number((accepted / (elapsedMs / 1_000)).toFixed(2)),
  ingestion_request_latency: formatLatency(ingestionLatencies),
  aggregation_requests: aggregationRequests,
  aggregation_errors: aggregationErrors,
  aggregation_latency: formatLatency(aggregationLatencies),
  docker_resource_samples: dockerSamples,
};

console.log(JSON.stringify(summary, null, 2));

if (failedRequests > 0 || rejected > 0 || accepted !== totalLogs) {
  process.exitCode = 1;
}
