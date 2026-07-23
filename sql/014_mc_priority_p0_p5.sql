-- Extend mc_priority to p0–p5 (additive; existing p0/p1/p2 rows unchanged).
-- Add priority to recurring_tasks so habits compete with tasks on daily cap.

do $$ begin
  alter type mc_priority add value 'p3';
exception when duplicate_object then null; end $$;

do $$ begin
  alter type mc_priority add value 'p4';
exception when duplicate_object then null; end $$;

do $$ begin
  alter type mc_priority add value 'p5';
exception when duplicate_object then null; end $$;

alter table public.recurring_tasks
  add column if not exists priority mc_priority not null default 'p1';

create index if not exists recurring_tasks_priority_idx on public.recurring_tasks (priority);
