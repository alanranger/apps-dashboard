-- Per-task effort estimate in minutes (nullable, no default, no backfill).
-- Foundation for realistic calendar scheduling; capture-once via task drawer.
alter table tasks add column if not exists est_minutes integer;
