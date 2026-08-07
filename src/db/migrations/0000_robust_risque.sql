CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE "logs" (
	"id" UUID PRIMARY KEY DEFAULT GEN_RANDOM_UUID() NOT NULL,
	"timestamp" TIMESTAMP WITH TIME ZONE NOT NULL,
	"level" VARCHAR(10) NOT NULL,
	"service" VARCHAR(255) NOT NULL,
	"message" TEXT NOT NULL,
	"attributes" JSONB DEFAULT '{}'::JSONB NOT NULL,
	"created_at" TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);

--> statement-breakpoint
CREATE INDEX "logs_timestamp_idx" ON "logs" USING BTREE ("timestamp");

--> statement-breakpoint
CREATE INDEX "logs_service_idx" ON "logs" USING BTREE ("service");

--> statement-breakpoint
CREATE INDEX "logs_level_idx" ON "logs" USING BTREE ("level");