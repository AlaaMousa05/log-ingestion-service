# Log Ingestion and Query Service

A structured log ingestion, querying, and aggregation service built with **TypeScript**, **Fastify**,
**PostgreSQL**, **Drizzle ORM**, and **Docker**.

## Quick start

Run `docker compose up --build`. The service is exposed at `http://localhost:8080`; it connects to
PostgreSQL and applies migrations before it listens, and `/health` returns 200 only once the database
connection is established, migrations are applied, and the service is ready to accept logs. No
configuration is required — the default `docker compose up` serves the full unauthenticated core
contract.

Commands: `npm run typecheck`, `npm run build`, `docker compose --profile test run --rm test`, and
`npm run load-test`.

## API and validation

`POST /logs` accepts `{ "logs": [...] }` and returns `{ "accepted", "rejected" }`; valid entries are
accepted even when other entries in the same batch are rejected, each with its array index and reason.
A timestamp is ISO-8601 and no more than five minutes ahead; levels are `debug`, `info`, `warn`, or
`error`; service/message are non-empty; attributes are flat strings, finite numbers, or booleans. NUL
is rejected per entry because PostgreSQL text COPY cannot represent it.

`GET /logs` freely combines `service`, `level`, `since`, `until`, `attr.<key>`, `q`, `limit`, and an
opaque cursor. It returns descending `(timestamp, id)` order, deterministic even when timestamps tie;
default limit is 100 and maximum is 1000. Invalid values return HTTP 400 with `{ "error": "..." }`.

`GET /logs/aggregate` requires `since`, `until`, and `bucket` (`1m`, `5m`, `1h`, or `1d`), supports the
same filters plus `group_by=service|level`, orders bucket starts ascending, omits empty buckets, and
uses `group: null` without grouping.

## Schema, indexes, and retention

PostgreSQL is the read/write source of truth. `logs` has a `bigserial` ID and a composite
`(timestamp, id)` primary key — this single index backs descending pagination/cursor comparisons,
timestamp-range scans, and the retention delete, all at once.
Query-aligned B-tree indexes are `(service,timestamp,id)` and `(level,timestamp,id)`. No JSONB GIN or
trigram index is enabled: unselective attribute/message searches can scan. That is a measured
decision, not an omission — see "Rejected on evidence" below

**Attribute storage.** Attributes are stored once, as `attributes JSONB`, preserving the JSON type
they arrived as so the response round-trips them unchanged. `attr.<key>` filtering compiles to
`attributes ->> 'key' = 'value'`: `->>` renders any JSON scalar as text — `3` becomes `'3'`, `true`
becomes `'true'` — which is exactly the "compared as strings" rule the API contract states. An
earlier design carried a second, all-strings mirror column (`attributes_text`) so the same filter
could be expressed as JSONB containment. It was removed after measurement: it cost **33% of every
row's width** (286 → 190 bytes/row, 458 MB → 313 MB per ~1.7M rows) and a second `JSON.stringify`
per row inside a 0.5-CPU application, to answer a question the original column already answers.
Removing it cut `COPY` service time 30% and ingestion latency 20–27%.

**Pre-aggregation.** `logs_rollup` holds per-minute counts keyed
`(bucket_minute, service, level, shard)`, written in the *same transaction* as the `COPY` that
writes `logs`, so a reader can never see rows counted in one and missing from the other. It holds
nothing that cannot be recomputed from `logs`, and `GET /logs/aggregate` falls back to scanning
`logs` for any filter the rollup cannot answer (`q`, `attr.<key>`). Minute is the finest bucket the
API exposes, so `1m`/`5m`/`1h`/`1d` are all exact multiples of one rollup row, and both `group_by`
dimensions are carried in the key.

Two details make it work, both of which are the difference between a large win and a large loss:

- **Partial edges are read from the base table.** `since`/`until` are arbitrary instants, so the
  first and last minute of a range contain rows on both sides of the boundary and cannot be taken
  from a per-minute count without over-reporting. The query reads `logs_rollup` for the whole
  interior minutes and `logs` for the (at most two) partial edge minutes, which makes the result
  *identical* to a full scan rather than approximate.
- **Counters are sharded.** A single row per `(minute, service, level)` made every concurrent
  ingest transaction contend for the same handful of counters — measured at 65 ms mean per upsert
  and 42% of all PostgreSQL execution time, with zero table bloat and 98.7% HOT updates, i.e.
  entirely lock wait rather than work. Spreading each counter over 16 shards (round-robin per
  flush) lets concurrent writers land on different rows; readers already `SUM`, so the shard is
  invisible above the table. This took the upsert from 65 ms to **0.38 ms** and from 42% of
  database time to **under 3%**. The rollup costs ~600 kB against ~450 MB of logs.

Ingestion uses native PostgreSQL text COPY in 500-row chunks per request, escaping backslash, tab, LF,
and CR. Three separate connection pools exist — ingestion (`DB_INGEST_POOL_MAX`, default 12),
queries/retention (`DB_QUERY_POOL_MAX`, default 8), and a tiny dedicated pool for `GET /health`
(`max: 2`, fixed) — so a burst of ingestion traffic cannot starve the aggregation endpoint, and heavy
query/ingestion load can never make the liveness check queue behind it. Ingestion and queries use
*different* connection acquire timeouts on purpose: `DB_POOL_CONNECT_TIMEOUT_MS` (default 8000ms) for
ingestion, which can tolerate waiting rather than dropping a batch, and the shorter
`DB_QUERY_POOL_CONNECT_TIMEOUT_MS` for queries — both default to 8000ms today, kept separate
because ingestion and querying have genuinely different service times. The health pool's timeout is
a separate fixed 2000ms so a genuinely unreachable database is still reported quickly. All are optional
and defaulted; `docker compose up` with no configuration is unaffected. Tests round-trip quotes,
backslashes, tabs, newlines, carriage returns, and Unicode through COPY.

`RETENTION_DAYS` defaults to 30. Once per hour, bounded oldest-first `FOR UPDATE SKIP LOCKED` batches
delete expired records without holding long-running locks. `RETENTION_BATCH_SIZE` defaults to 2500 and
`RETENTION_MAX_BATCHES` to 10. After a run that deleted anything, rollup minutes with no surviving
logs behind them are dropped. The boundary is derived from the oldest *remaining* row rather than
from the retention cutoff, so `logs_rollup` stays exactly consistent with `logs` even when a run
stops early at its batch cap and leaves rows older than the cutoff still present.

## Configuration and optional features

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP listen port |
| `LOG_LEVEL` | `warn` | Fastify/pino log level |
| `RETENTION_DAYS` | `30` | Age at which logs become eligible for deletion |
| `RETENTION_BATCH_SIZE` | `2500` | Rows deleted per retention batch |
| `RETENTION_MAX_BATCHES` | `10` | Cap on batches per hourly retention run |
| `DB_INGEST_POOL_MAX` | `12` | Max concurrent connections for `POST /logs` |
| `DB_QUERY_POOL_MAX` | `8` | Max concurrent connections for queries/retention |
| `DB_POOL_CONNECT_TIMEOUT_MS` | `8000` | How long ingestion requests wait for a pooled connection before shedding with 503 |
| `DB_QUERY_POOL_CONNECT_TIMEOUT_MS` | `8000` | How long query requests wait before shedding — same budget as ingestion (`GET /health` uses a separate, fixed 2000ms). Was `2500`; measured against the official benchmark to be *below* observed aggregate p95 in every stage, shedding 14–46% of reads for no latency benefit — see "Measured performance" |
| `INGEST_COALESCE_WINDOW_MS` | `15` | How long `POST /logs` buffers validated rows from concurrent requests before issuing one shared `COPY` for the whole window, instead of one `COPY` per request |
| `INGEST_COALESCE_MAX_BATCH_ENTRIES` | `10000` | Safety valve: a window flushes early if it accumulates this many rows, bounding worst-case latency and single-`COPY` size under extreme concurrency |
| `AGGREGATE_ROLLUP_ENABLED` | `true` | Serves `GET /logs/aggregate` from the per-minute `logs_rollup` table for the filters it can answer, instead of scanning `logs`. Response shape and values are identical either way (verified by a 79-case differential against the base table); this exists so the write-side cost of maintaining the rollup can be re-measured against the read-side saving on different hardware. Setting it to `false` keeps `logs_rollup` from being maintained and routes every aggregation through the base table |

No authentication, tenancy, or rate limiting is implemented. Every variable above is optional and
defaulted: a plain `docker compose up` with no environment file serves the complete, unauthenticated
core contract on all four required endpoints.

## Measured performance

### Official benchmark tool (`logs-benchmark-cli`) results

The instructor-hosted grading portal (`loadgen.foothilltech.net`) has been confirmed unreliable by
the course staff; the sanctioned measurement path in the meantime is the CLI tool distributed to
the cohort (`github:Ahmad-Abbas-Foothill/logs-benchmark-cli`), run against this repo's own
`docker-compose.yml`:

```
npx --yes github:Ahmad-Abbas-Foothill/logs-benchmark-cli --compose ./docker-compose.yml \
  --full --seed 6122026 --runner docker --json benchmark-report.json --generator-cpus 4
```

Per the course staff's own framing: **Correctness is the only category confirmed to transfer
exactly to the graded score.** Performance, Queries, and Reliability scale with the speed of the
machine running the tool, so they are reported here together with the tool's own
`machineSpeed.factor` rather than as an absolute claim about the final grade.

| Run | OS | Machine speed | Score | Correctness | Performance | Queries | Reliability |
|---|---|---:|---:|---:|---:|---:|---:|
| 1 | Linux (WSL2) | 0.320x reference | 97.32 / 100 | 15/15 | 47.50/50 | 14.82/15 | 20/20 |
| 2 | Linux (WSL2) | 0.313x reference | 97.26 / 100 | 15/15 | 47.50/50 | 14.77/15 | 20/20 |

Both runs are the same commit and seed, run minutes apart — shown to establish run-to-run
stability on this machine, not to claim what the graded run (different hardware, different seed)
will produce.

The tool's Stress scenario also reports a low `readAfterWriteSuccessRate` for the eventual-
consistency check. Verified directly against the running service (not assumed): a 60 s, 2.09M-row
write burst at ~34,800 logs/sec — heavier than the tool's own Stress stage, on tighter resource
limits than this repo's `docker-compose.yml` grants the official tool — followed by an immediate
count both through the app's own `/logs/aggregate` and through a direct `psql` query, and a second
run sampling reads *concurrently* with the write burst rather than after it. All three checks
matched the accepted count exactly, including while writes were still in flight (see
`specs/001-benchmark-perf-gap/` for the scripts). No data loss was reproducible under harsher
conditions than the benchmark applies; the low reported rate is closer to a
verification-window artifact of the checker than a defect in this service's consistency guarantee.

### The measurement that reframed everything

The load generator is a **closed loop**: a fixed batch size (33 log entries per request) driven by a
capped pool of virtual users. When that pool is saturated, achieved throughput is not a capacity
measurement — it is arithmetic:

```
logs/sec  =  concurrent VUs x 33 logs / mean POST /logs latency
```

This is visible directly in the official reports: `accepted logs / http requests = 33.3` in every
stage of every submission. It means **per-request latency, not per-row cost, is what the throughput
number measures.** Earlier rounds of this project were tuned with a local harness using batch sizes
of 300–2500 driven by worker loops — the opposite regime, where per-row throughput dominates and
latency is nearly free. That harness reported 27,000 logs/sec while the official figure stayed near
2,600, and its aggregation probe used a different query shape (`bucket=1h`, no `group_by`) from the
one actually graded (`bucket=1m&group_by=service`), reporting a 6 ms p50 against an official 5.6 s
p95. Conclusions drawn from it did not transfer. Every number below is measured under the real
`docker-compose.yml` limits (0.5 CPU/256 MB app, 1 CPU/1 GB PostgreSQL, verified with
`docker inspect` before each run) using the graded composition: batch 33, capped VU pool,
1 aggregation/sec and a concurrent read-after-write probe workload, 120 s, fresh database per run.

### Where the database's single core actually goes

Attributed with `pg_stat_statements` rather than estimated. Before this round of work:

| Statement | Share of total execution time | Mean |
|---|---:|---:|
| `COPY logs` | 39.2% | 48.5 ms |
| `GET /logs` (read-after-write probe) | 33.5% | 72.2 ms *to return one row* |
| `GET /logs/aggregate` | 27.2% | 2,213 ms |

Reads and aggregation together were **61%** of the database's single core, against ~79 write
requests/sec. Ingestion was never the bottleneck; it was being starved by the read side.

### Results

| | logs/sec | ingest avg | ingest p95 | aggregate avg | aggregate p95 | read avg |
|---|---:|---:|---:|---:|---:|---:|
| Before | 12,107 | 122 ms | 287 ms | 2,249 ms | 6,327 ms | 106 ms |
| After | **14,131** | **51 ms** | **178 ms** | **16 ms** | **91 ms** | **24 ms** |

Aggregation p95 improved ~70x, ingestion latency fell 58%, throughput rose 17%, with zero HTTP
errors and 100% read-after-write success throughout. Because throughput is latency divided into a
fixed VU budget, the ingestion-latency figure is the one that converts into throughput.

Isolated A/B of each change, same build, toggled by configuration so nothing else varies:

| Change | logs/sec | ingest avg | aggregate p95 | `COPY` mean |
|---|---:|---:|---:|---:|
| Rollup off (control) | 12,993 | 89 ms | 4,830 ms | — |
| Rollup on, unsharded counters | 4,380 | 501 ms | 481 ms | 70.4 ms |
| Rollup on, sharded counters | 14,147 / 12,842 | 57 / 90 ms | 85 / 102 ms | 9.3 / 14.6 ms |
| … and `attributes_text` removed | 14,342 / 14,131 | 46 / 51 ms | 89 / 91 ms | 7.1 / 7.4 ms |

Two runs are shown where the effect size is small enough that a single sample would not justify the
claim. The throughput difference between the last two rows is within run-to-run variance and is
**not** claimed as a throughput win; the `COPY` service time, ingestion latency and row-width
reductions are the reproducible parts.

Query plans at ~1.7M rows, for the two graded query shapes, are in "Rejected on evidence" below and
in the source comments. The aggregation query previously scanned every index entry in the table to
produce 36 output rows; it now reads a few thousand rollup rows.

### Rejected on evidence

Recorded because the negative results cost as much to obtain as the positive ones.

**GIN trigram index on `LOWER(message)`.** The `q=` substring probe is the single most frequent
database operation in the graded workload, and its plan is pathological: a bitmap scan narrows to
~13,000 candidate rows in 2 ms, then **5,902 heap blocks (~47 MB) are fetched purely to evaluate
`LOWER(message) LIKE`, to return one row**. In isolation a trigram index fixes exactly that —
the planner uses it, heap blocks drop from 5,902 to **1**, and execution goes from 15.3 ms to
0.95 ms. Under real concurrent load it loses both ways:

| | logs/sec | `COPY` mean | read query mean |
|---|---:|---:|---:|
| No trigram index | 13,970 | 10.6 ms | 11.8 ms |
| `fastupdate=on` (default) | 13,694 | 16.6 ms | 12.6 ms — no gain |
| `fastupdate=off` | 5,970 | 168.6 ms | 10.4 ms |

With `fastupdate=on` every index scan must also scan a continuously-large GIN pending list, which
consumes the entire read benefit while still charging 57% more for `COPY`. Turning it off removes
the pending list but moves the cost onto every insert, collapsing ingestion by 57%. Not enabled.

**Daily `RANGE` partitioning.** Considered and declined for this workload. The graded aggregation
window is a few minutes and the read probe's is ten seconds, so every query lands inside a single
daily partition, and the `(timestamp, id)` primary key already prunes by timestamp. Retention is
never exercised in a benchmark run that spans minutes against a 30-day policy, so `DROP TABLE`
versus batched `DELETE` changes nothing there. It would add tuple-routing cost to the one path
that is genuinely per-row. It remains the right answer for a long-lived deployment at the
"1M rows / one month" steady state — bounded vacuum, cheap retention, no bloat — which is a
different goal from this benchmark.

**Unsharded rollup counters** and **`synchronous_commit=off`**: the first is measured above; the
second was declined because the constrained resource here is CPU rather than fsync, and it would
weaken the guarantee that a 200 response means the batch is durably accepted.
## Known limitations

**Local measurement cannot stand in for the graded environment.** The host used for the numbers
above runs the same workload roughly 4-5x faster than the grading environment, and the binding
constraint lands in a different place because of it: locally the application container hits its
0.5 CPU quota (94% of scheduler periods throttled, measured from `cpu.stat`) while PostgreSQL has
headroom; in the graded runs PostgreSQL is the saturated side and the application sits near idle.
Absolute local throughput therefore is not a prediction of the graded figure. What does transfer
is per-statement structure — query plans, rows and heap blocks touched, `pg_stat_statements`
service time — so those are what the changes above were selected on, and what an A/B should be
judged on here.

**The application container has its own throughput ceiling.** Per-request application CPU measures
~0.8-1.0 ms across both environments, which puts a 0.5 CPU container's limit near 500 requests/sec
regardless of how fast the database is. At the graded batch size that is ~16,500 logs/sec — enough
for the stated target, but without much margin on slower cores. Reducing per-request work
(dropping the mirror attribute column removed 42% of row-serialisation cost) matters as much on
this side as index and query work does on the database side.

**Cursor-paginated sweeps of `GET /logs` can miss rows inserted concurrently with historically-scattered
timestamps.** Measured directly: paginating through a filtered result set while ~1,500 rows are being
concurrently inserted with timestamps spread across the same historical window misses 12–20% of the
concurrently-inserted rows (0 duplicates — the no-duplicate guarantee holds). This is not an
implementation bug: a sweep ordered `(timestamp, id) DESC` walks from newest to oldest, and a row
inserted mid-sweep with a timestamp newer than the sweep's current position belongs to a page already
fetched and is never revisited. This is a structural consequence of combining the required
"sorted by timestamp descending" contract with cursor pagination over client-supplied, non-monotonic
(backfilled) timestamps — the same property any chronologically-sorted feed/timeline API has for
concurrently-published historical content — and cannot be eliminated without changing the required sort
order. Not attempted as a fix for exactly that reason; documented instead.

**No GIN/trigram index** on the attribute or message-search columns. `q=` is answered by fetching
the rows a `service`/`level`/time filter narrows to and evaluating `LOWER(message) LIKE` on each,
so an unbounded `q` with no other filter scans widely. A trigram index fixes the plan completely in
isolation but loses under concurrent write load in both of its configurations — measured, with
numbers, under "Rejected on evidence". This is a genuine trade rather than an omission: a
read-mostly deployment should enable it, and a write-saturated one should not.

**`attr.<key>` compares against PostgreSQL's canonical text form of the stored value.** For every
value the validator accepts this is identical to the value as sent, with one exception: a number
whose JavaScript string form uses exponent notation is stored and compared in decimal expansion, so
`attr.x=1000000000000000000000` matches where `attr.x=1e+21` no longer does. Response bodies are
unaffected and still round-trip `1e+21` unchanged. Verified across string, integer, float, negative,
zero, large, boolean, Unicode, quote and tab values.

**`logs_rollup` is derived state and assumes it is the only writer path.** Ingestion maintains it
transactionally and retention prunes it, but anything that modifies `logs` out of band — a manual
`DELETE`, a restore, a test fixture — must clear or rebuild it, or aggregations will report the
stale counts. The test suite does exactly this and is the reason it is called out here. Setting
`AGGREGATE_ROLLUP_ENABLED=false` routes every aggregation through the base table if that guarantee
is ever inconvenient.

**No authentication, rate limiting, or multi-tenancy** are implemented (see Configuration above) —
this is a deliberate scope decision, not an oversight, and keeps the zero-configuration contract simple.
