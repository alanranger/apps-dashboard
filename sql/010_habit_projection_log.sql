-- Habit projection write-back audit columns on recurring_log.
-- Applied by POST /api/mc/habit-scheduled. Safe to re-run.

alter table public.recurring_log
  add column if not exists ideal_date date,
  add column if not exists scheduled_date date,
  add column if not exists roll_reason text,
  add column if not exists calendar_event_id text,
  add column if not exists projection_key text;
