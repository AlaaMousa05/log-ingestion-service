CREATE TABLE IF NOT EXISTS "logs_rollup" (
	"bucket_minute" timestamp with time zone NOT NULL,
	"service" text NOT NULL,
	"level" "log_level" NOT NULL,
	"count" bigint NOT NULL,
	CONSTRAINT "logs_rollup_bucket_minute_service_level_pk" PRIMARY KEY("bucket_minute","service","level")
);
--> statement-breakpoint
ALTER TABLE "logs_rollup" SET (
	fillfactor = 70,
	autovacuum_vacuum_scale_factor = 0.0,
	autovacuum_vacuum_threshold = 500,
	autovacuum_vacuum_cost_delay = 0
);
