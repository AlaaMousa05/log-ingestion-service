-- Counter sharding. Every ingest transaction previously incremented the same
-- (minute, service, level) row, so concurrent COPY transactions serialised on
-- those few hot counters: measured at 65ms mean per upsert and 42% of all
-- PostgreSQL execution time, with zero table bloat and 98.7% HOT updates --
-- i.e. entirely lock wait, not work. Spreading each counter over several
-- physical rows lets concurrent writers touch different rows; the aggregate
-- already SUMs, so the result is unchanged.
DROP TABLE IF EXISTS "logs_rollup";
--> statement-breakpoint
CREATE TABLE "logs_rollup" (
	"bucket_minute" timestamp with time zone NOT NULL,
	"service" text NOT NULL,
	"level" "log_level" NOT NULL,
	"shard" smallint NOT NULL,
	"count" bigint NOT NULL,
	CONSTRAINT "logs_rollup_pk" PRIMARY KEY("bucket_minute","service","level","shard")
);
--> statement-breakpoint
ALTER TABLE "logs_rollup" SET (
	fillfactor = 70,
	autovacuum_vacuum_scale_factor = 0.0,
	autovacuum_vacuum_threshold = 500,
	autovacuum_vacuum_cost_delay = 0
);
--> statement-breakpoint
-- Rebuild from the source of truth, so an existing deployment keeps exact
-- counts across this migration instead of silently losing history.
INSERT INTO "logs_rollup" ("bucket_minute", "service", "level", "shard", "count")
SELECT date_bin('1 minute', "timestamp", TIMESTAMPTZ '2026-01-01 00:00:00+00'),
       "service", "level", 0, count(*)
FROM "logs"
GROUP BY 1, 2, 3;
