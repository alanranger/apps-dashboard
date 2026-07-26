-- Consolidated Google Calendar push queue (DB is master; Claude flushes writes).
-- One related_id = one net change. Multiple diary edits collapse to latest payload.
-- status: pending (edited) → ready (Alan hit Push) → applied | dismissed (Claude/Alan)

create table if not exists public.gcal_push_queue (
  id uuid primary key default gen_random_uuid(),
  related_id text not null,
  entity_type text not null
    check (entity_type in ('task', 'habit', 'travel', 'other')),
  change_kind text not null
    check (change_kind in (
      'move', 'complete', 'skip', 'dismiss', 'pin', 'unlock',
      'habit_placement', 'task_bump', 'travel_back_fix', 'backlog'
    )),
  summary text not null,
  proposed_action text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'ready', 'applied', 'dismissed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by text,
  constraint gcal_push_queue_related_id_unique unique (related_id)
);

create index if not exists gcal_push_queue_status_idx
  on public.gcal_push_queue (status, updated_at desc);

comment on table public.gcal_push_queue is
  'Cursor-owned consolidated GCal write manifest. Claude flushes ready rows; apps-dashboard never writes Calendar.';

insert into public.scheduling_rules (key, value)
values ('gcal_writes_available', 'false')
on conflict (key) do nothing;

comment on column public.scheduling_rules.value is
  'String rule values. gcal_writes_available=true only when Anthropic GCal writes recover.';
