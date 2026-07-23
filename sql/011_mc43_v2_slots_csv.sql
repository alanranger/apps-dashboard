-- MC-43 v2: task slots, completion, CSV snapshot source mtime, Part 2 rule seeds, retire recurrence_day

alter table public.tasks
  add column if not exists scheduled_start timestamptz,
  add column if not exists scheduled_end timestamptz,
  add column if not exists slot_pinned boolean not null default false,
  add column if not exists slot_pinned_at timestamptz,
  add column if not exists slot_pinned_from timestamptz,
  add column if not exists completed_on date,
  add column if not exists calendar_event_id text;

alter table public.tasks drop column if exists recurrence_day;

create table if not exists public.schedule_csv_snapshot (
  row_key text primary key,
  title text not null,
  start_date date not null,
  kind text not null,
  location_name text,
  seen_at timestamptz not null default now(),
  source_mtime timestamptz,
  source_name text
);

insert into public.scheduling_rules (key, value, value_type, description) values
  ('working_hours_weekday_start', '10:00', 'time', 'Earliest MC block start Mon–Fri'),
  ('working_hours_weekday_end', '17:00', 'time', 'MC block must END by this Mon–Fri'),
  ('working_hours_weekend_start', '11:00', 'time', 'Earliest MC block start Sat–Sun'),
  ('working_hours_weekend_end', '16:00', 'time', 'MC block must END by this Sat–Sun'),
  ('working_days', 'mon,tue,wed,thu,fri,sat,sun', 'text', 'Schedulable weekdays'),
  ('exclude_bank_holidays', 'true', 'bool', 'No MC blocks on UK E&W bank holidays'),
  ('decompress_after_task_min', '30', 'int', 'Gap after every MC task block'),
  ('daily_task_cap_min', '240', 'int', 'Max MC task minutes per day (gaps excluded)'),
  ('manual_move_policy', 'pin_forever', 'text', 'Manual calendar move policy'),
  ('manual_move_changes_due_date', 'false', 'bool', 'Moving work block never changes due_date')
on conflict (key) do nothing;
