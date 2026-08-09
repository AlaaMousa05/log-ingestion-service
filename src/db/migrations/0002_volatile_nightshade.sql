CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX "logs_message_search_idx" ON "logs" USING gin (LOWER("message") gin_trgm_ops);