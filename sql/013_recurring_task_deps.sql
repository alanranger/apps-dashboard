-- MC-43: habit dependencies enforced in the DB (not prose in notes_md).
-- A dependent habit must not be scheduled before its blocker; the scheduler
-- (Claude, via habit-projection.json) reads this table and honours it.

create table if not exists public.recurring_task_deps (
  id uuid primary key default gen_random_uuid(),
  habit_id uuid not null references public.recurring_tasks(id) on delete cascade,
  depends_on_habit_id uuid not null references public.recurring_tasks(id) on delete cascade,
  dep_type text not null check (dep_type in ('must_complete_first', 'same_day_after', 'within_hours')),
  within_hours int,
  notes text,
  created_at timestamptz not null default now(),
  unique (habit_id, depends_on_habit_id),
  constraint recurring_task_deps_no_self check (habit_id <> depends_on_habit_id),
  constraint recurring_task_deps_within_hours_required
    check (dep_type <> 'within_hours' or within_hours is not null)
);

create index if not exists idx_rtd_habit on public.recurring_task_deps (habit_id);
create index if not exists idx_rtd_blocker on public.recurring_task_deps (depends_on_habit_id);

-- Seed the three real dependencies. Title-based lookups keep this portable and
-- idempotent: on a DB where the habits don't exist the SELECT yields no rows,
-- so nothing is inserted; re-running is a no-op via ON CONFLICT.
insert into public.recurring_task_deps (habit_id, depends_on_habit_id, dep_type, within_hours, notes)
select d.id, b.id, 'must_complete_first', null,
       'Day 2 Phase 2 needs 05-event-product-mappings-latest.csv produced by Day 1 preliminary ingest'
from public.recurring_tasks d
join public.recurring_tasks b on b.title = 'BAU global refresh - Day 1: CSVs + preliminary ingest'
where d.title = 'BAU global refresh - Day 2: schemas + final ingest + verify'
on conflict (habit_id, depends_on_habit_id) do nothing;

insert into public.recurring_task_deps (habit_id, depends_on_habit_id, dep_type, within_hours, notes)
select d.id, b.id, 'within_hours', 24,
       'Must run within 24h of the BAU refresh completing or the uploaded data is stale'
from public.recurring_tasks d
join public.recurring_tasks b on b.title = 'BAU global refresh - Day 2: schemas + final ingest + verify'
where d.title = 'Upload sites - LocalViking, TOGDays, Where Can We Go'
on conflict (habit_id, depends_on_habit_id) do nothing;

insert into public.recurring_task_deps (habit_id, depends_on_habit_id, dep_type, within_hours, notes)
select d.id, b.id, 'same_day_after', null,
       'Alan''s actions slot follows Claude''s hotel scan the same morning'
from public.recurring_tasks d
join public.recurring_tasks b on b.title = 'Hotel bookings check (Claude)'
where d.title = 'Hotel bookings - Alan actions'
on conflict (habit_id, depends_on_habit_id) do nothing;
