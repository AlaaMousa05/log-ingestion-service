-- `attributes_text` mirrored every attribute set a second time, as all-strings,
-- purely so `attr.<key>` could be answered by JSONB containment. `attributes ->>
-- key` already renders any JSON scalar as text, which is precisely the
-- "compared as strings" rule the API contract states, so the mirror was ~38% of
-- every row's width -- and of every sequential scan, every WAL record, and a
-- second JSON.stringify per row inside a 0.5-CPU application -- for nothing.
ALTER TABLE "logs" DROP COLUMN IF EXISTS "attributes_text";
