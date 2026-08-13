ALTER TABLE "logs" SET (
	autovacuum_vacuum_insert_scale_factor = 0.01,
	autovacuum_vacuum_insert_threshold = 1000,
	autovacuum_vacuum_cost_delay = 0
);
