-- Recurring tasks tab (Reclaim.ai replacement) — run on alan-chat-rag after 001–003.

create table if not exists recurring_tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  cadence_text text not null,
  rrule text not null,
  duration_min int not null default 60,
  ideal_time time not null default '09:00',
  window_days int not null default 2,
  notes_md text,
  scheduled_note text,
  active boolean not null default true,
  last_scheduled date,
  last_done date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists recurring_log (
  id uuid primary key default gen_random_uuid(),
  recurring_task_id uuid not null references recurring_tasks(id) on delete cascade,
  at timestamptz not null default now(),
  actor mc_actor not null,
  change text not null
);

create index if not exists recurring_log_task_idx on recurring_log(recurring_task_id, at desc);
create index if not exists recurring_tasks_active_idx on recurring_tasks(active);

-- Seeds (Alan Reclaim board 20 Jul 2026 — skip if already present)
do $$
begin
  if exists (select 1 from recurring_tasks limit 1) then
    raise notice 'recurring_tasks already seeded — skipping';
    return;
  end if;

  insert into recurring_tasks (title, cadence_text, rrule, duration_min, ideal_time) values
    ('Backup Photos to Portable Drive', '5th day monthly', 'FREQ=MONTHLY;BYMONTHDAY=5', 60, '09:00'),
    ('SEO Performance Review', '4th day monthly', 'FREQ=MONTHLY;BYMONTHDAY=4', 90, '16:00'),
    ('Publish Blog Post', 'Every Thursday', 'FREQ=WEEKLY;BYDAY=TH', 120, '11:00'),
    ('Send Out Joining Details', 'Every Friday', 'FREQ=WEEKLY;BYDAY=FR', 60, '09:00'),
    ('Check Artfully Walls Sales', '2nd Thursday monthly', 'FREQ=MONTHLY;BYDAY=2TH', 15, '09:00'),
    ('Review/Amend Course & Workshop Dates + check Hotel Bookings', 'Every Friday', 'FREQ=WEEKLY;BYDAY=FR', 120, '10:00'),
    ('Update Event Schema for Classes & Workshops', '4th Monday every other month', 'FREQ=MONTHLY;INTERVAL=2;BYDAY=4MO', 120, '09:00'),
    ('Monthly Accounts — Bank Genie', '3rd day monthly', 'FREQ=MONTHLY;BYMONTHDAY=3', 90, '09:00'),
    ('Booking Sheet, Month End Update', '1st day monthly', 'FREQ=MONTHLY;BYMONTHDAY=1', 60, '09:00'),
    ('Upload Events to Viking GMB', '3rd Saturday every 3 months', 'FREQ=MONTHLY;INTERVAL=3;BYDAY=3SA', 60, '09:00');

  -- Alan review task (skip if already present)
  insert into tasks (project_id, title, detail_md, owner, state, priority, why, response_file)
  select p.id,
    'Review: Recurring tab (Reclaim replacement)',
    'New **Recurring** tab shipped. Verify: 10 seeds match Reclaim board, edit presets work, mark-done logs, no calendar code in diff, existing Dashboard/Board unchanged. Post screenshots in notes.',
    'alan', 'todo', 'p1',
    'Gate before cancelling Reclaim.ai subscription',
    'RESPONSE-2026-07-20-BUILD-MC-recurring-tab-reclaim-replacement-LATEST.md'
  from projects p
  where p.name = 'Platform & costs'
    and not exists (select 1 from tasks where title = 'Review: Recurring tab (Reclaim replacement)');
end $$;
