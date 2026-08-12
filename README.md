# Log Ingestion and Query Service

A high-performance structured log ingestion, querying, and aggregation service built with **TypeScript**, **Fastify**, **PostgreSQL**, **Drizzle ORM**, and **Docker**.

## Quick start

Run `docker compose up --build`. The service is exposed at `http://localhost:8080`; it connects to PostgreSQL and applies migrations before it listens, and `/health` returns 200 only when ready.

Commands: `npm run typecheck`, `npm run build`, `docker compose run --rm test`, and `npm run load-test`.

## API and validation

`POST /logs` accepts `{ "logs": [...] }` and returns `{ "accepted", "rejected" }`; valid entries are accepted even when other entries are rejected with their array index and reason. A timestamp is ISO-8601 and no more than five minutes ahead; levels are `debug`, `info`, `warn`, or `error`; service/message are non-empty; attributes are flat strings, finite numbers, or booleans. NUL is rejected per entry because PostgreSQL text COPY cannot represent it.

`GET /logs` freely combines `service`, `level`, `since`, `until`, `attr.<key>`, `q`, `limit`, and an opaque cursor. It returns descending `(timestamp, id)` order; default limit is 100 and maximum is 1000. Invalid values return HTTP 400 with `{ "error": "..." }`.

`GET /logs/aggregate` requires `since`, `until`, and `bucket` (`1m`, `5m`, `1h`, or `1d`), supports the same filters plus `group_by=service|level`, orders bucket starts ascending, omits empty buckets, and uses `group: null` without grouping.

## Schema, indexes, and retention

PostgreSQL is the read/write source of truth. `logs` has a `bigserial` ID and `(timestamp,id)` primary key for deterministic cursors; it stores original values in `attributes JSONB` and string-normalized values in `attributes_text JSONB` to implement attribute equality as strings. Query-aligned B-tree indexes are `(service,timestamp,id)` and `(level,timestamp,id)`. No JSONB GIN or trigram index is enabled: unselective attribute/message searches can scan, but those indexes would harm the COPY ingestion workload without measured need.

Ingestion uses native PostgreSQL text COPY in 500-entry chunks, escaping backslash, tab, LF, and CR. Tests round-trip quotes, backslashes, tabs, newlines, carriage returns, and Unicode.

`RETENTION_DAYS` defaults to 30. Once per hour, bounded oldest-first `FOR UPDATE SKIP LOCKED` batches delete expired records. `RETENTION_BATCH_SIZE` defaults to 2500 and `RETENTION_MAX_BATCHES` to 10. PostgreSQL vacuum monitoring remains necessary for long-lived high churn.

## Configuration and optional features

`PORT=8080`, `LOG_LEVEL=warn`, `RETENTION_DAYS=30`, `RETENTION_BATCH_SIZE=2500`, and `RETENTION_MAX_BATCHES=10` are the defaults. Load-test controls are `TOTAL_LOGS=1000000`, `BATCH_SIZE=2500`, and `WORKERS=6`. No auth, tenancy, or rate limiting is implemented: plain `docker compose up` serves the core contract unauthenticated with no manual setup.

## Measured performance

Final verification used a fresh isolated database, PostgreSQL limited to 1 CPU/1 GiB, and an application limited to 0.5 CPU/256 MiB. The load generator sent 1,000,000 month-distributed logs in 400 batches of 2,500 using six workers while issuing an ungrouped 1-hour aggregation about once per second.

| Metric | Result |
| --- | ---: |
| accepted / rejected / failed / dropped | 1,000,000 / 0 / 0 / 0 |
| ingestion throughput | 33,185.11 logs/sec |
| ingestion p50 / p95 / p99 | 397.39 / 696.94 / 2,054.95 ms |
| aggregation requests / errors | 30 / 0 |
| aggregation p50 / p95 / p99 | 474.02 / 997.37 / 1,125.76 ms |
| final stored records / size | 1,000,000 / 437 MiB |

`EXPLAIN (ANALYZE, BUFFERS)` used an index-only scan, hash aggregation into 721 buckets, and a 47 KiB final sort; it completed in 702.71 ms. PostgreSQL CPU saturation and full-range scans are the main bottlenecks. During durable loading, app memory was about 65?69 MiB and PostgreSQL peaked around 823 MiB; application CPU was about 40?49% and PostgreSQL 90?97%.



  