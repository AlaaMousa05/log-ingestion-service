import pg from "pg";

const password = process.env.POSTGRES_PASSWORD ?? "postgres";
const admin = new pg.Client({
  connectionString: `postgresql://postgres:${password}@postgres:5432/postgres`,
});

await admin.connect();

const result = await admin.query(
  "SELECT 1 FROM pg_database WHERE datname = 'log_ingestion_test'",
);

if (result.rowCount === 0) {
  await admin.query("CREATE DATABASE log_ingestion_test");
}

await admin.end();
