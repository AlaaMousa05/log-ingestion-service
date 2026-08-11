DROP INDEX "logs_service_idx";--> statement-breakpoint
DROP INDEX "logs_level_idx";--> statement-breakpoint
ALTER TABLE "logs" ADD COLUMN "attributes_text" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
-- Backfill rows written before this migration existed. `attributes` values are
-- always flat scalars (enforced at ingest), so `#>> '{}'` safely stringifies
-- each one (numbers/booleans render the same as JS String(value)).
UPDATE "logs"
SET "attributes_text" = (
  SELECT COALESCE(jsonb_object_agg(entry.key, entry.value #>> '{}'), '{}'::jsonb)
  FROM jsonb_each("logs"."attributes") AS entry
)
WHERE "attributes" <> '{}'::jsonb;--> statement-breakpoint
CREATE INDEX "logs_service_timestamp_id_idx" ON "logs" USING btree ("service","timestamp" DESC,"id" DESC);--> statement-breakpoint
CREATE INDEX "logs_level_timestamp_id_idx" ON "logs" USING btree ("level","timestamp" DESC,"id" DESC);--> statement-breakpoint
CREATE INDEX "logs_attributes_text_gin_idx" ON "logs" USING gin ("attributes_text" jsonb_path_ops);