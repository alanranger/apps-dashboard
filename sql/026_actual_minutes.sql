-- Actual time spent when completing from Diary (vs est_minutes plan).
alter table public.tasks add column if not exists actual_minutes integer;
comment on column public.tasks.actual_minutes is
  'Minutes actually spent when marked complete from Diary (vs est_minutes plan).';
