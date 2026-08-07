const TOTAL_LOGS = 150_000;
const BATCH_SIZE = 1_000;
const URL = "http://localhost:8080/logs";

const levels = ["info", "warn", "error"];
const services = ["auth", "checkout", "payments", "orders"];

const start = Date.now();
let accepted = 0;

for (let offset = 0; offset < TOTAL_LOGS; offset += BATCH_SIZE) {
  const size = Math.min(BATCH_SIZE, TOTAL_LOGS - offset);

  const logs = Array.from({ length: size }, (_, i) => ({
    timestamp: new Date(
      Date.now() - ((offset + i) % 86_400_000),
    ).toISOString(),
    level: levels[(offset + i) % levels.length],
    service: services[(offset + i) % services.length],
    message: `load test log ${offset + i}`,
    attributes: {
      user_id: String((offset + i) % 1000),
      region: "eu-west",
      request_id: `req-${offset + i}`,
    },
  }));

  const response = await fetch(URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ logs }),
  });

  if (!response.ok) {
    console.error(
      `Batch failed at offset ${offset}: ${response.status}`,
    );
    console.error(await response.text());
    process.exit(1);
  }

  const result = (await response.json()) as {
    accepted?: number;
    rejected?: unknown[];
  };

  accepted += result.accepted ?? 0;

  if ((offset + size) % 10_000 === 0) {
    console.log(`Inserted ${offset + size}/${TOTAL_LOGS}`);
  }
}

const elapsed = Date.now() - start;

console.log("");
console.log(`Accepted: ${accepted}`);
console.log(`Elapsed: ${elapsed} ms`);
console.log(
  `Rate: ${Math.round(accepted / (elapsed / 1000))} logs/sec`,
);
