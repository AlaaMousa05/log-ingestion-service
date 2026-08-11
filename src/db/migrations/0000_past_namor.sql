CREATE TYPE "public"."log_level" AS ENUM('debug', 'info', 'warn', 'error');--> statement-breakpoint
CREATE TABLE "logs" (
	"id" bigserial NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"level" "log_level" NOT NULL,
	"service" text NOT NULL,
	"message" text NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attributes_text" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "logs_timestamp_id_pk" PRIMARY KEY("timestamp","id")
);
--> statement-breakpoint
CREATE INDEX "idx_logs_service_timestamp_id" ON "logs" USING btree ("service","timestamp","id");--> statement-breakpoint
CREATE INDEX "idx_logs_level_timestamp_id" ON "logs" USING btree ("level","timestamp","id");