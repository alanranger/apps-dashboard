-- MC-43: Scheduling Rules tab + diary-drift detector (detect only — never writes Calendar)
-- Applied remotely 2026-07-21. Keep in sync for fresh environments.

alter table public.recurring_tasks
  add column if not exists rolls_used int not null default 0;

create table if not exists public.scheduling_rules (
  key text primary key,
  value text not null,
  value_type text not null default 'text',
  description text,
  updated_at timestamptz not null default now()
);

create table if not exists public.scheduling_rules_audit (
  id uuid primary key default gen_random_uuid(),
  key text not null,
  old_value text,
  new_value text not null,
  changed_by text not null,
  at timestamptz not null default now()
);

create table if not exists public.venue_drive_times (
  id uuid primary key default gen_random_uuid(),
  venue_name text not null unique,
  postcode text,
  minutes_from_home int not null,
  minutes_from_hotel int,
  notes text,
  verified_by text,
  verified_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.workshop_hotels (
  id uuid primary key default gen_random_uuid(),
  workshop_name text not null,
  workshop_dates text,
  hotel text,
  booking_ref text,
  booked_via text,
  rooms int,
  total_cost numeric,
  free_cancel_until date,
  check_in_date date,
  notes text,
  reminder_placed boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists public.pending_diary_changes (
  id uuid primary key default gen_random_uuid(),
  change_type text not null,
  target_date date,
  summary text not null,
  proposed_action text not null,
  reason text,
  urgency text not null default 'normal',
  status text not null default 'pending',
  related_id text,
  detected_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by text
);

create index if not exists pending_diary_changes_status_idx
  on public.pending_diary_changes(status, detected_at desc);
