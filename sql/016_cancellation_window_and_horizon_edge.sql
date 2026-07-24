-- Cancellation window + reminder lead override on workshop_hotels.
-- horizon_edge scheduling_rules defaults. Applied remotely 2026-07-24.

alter table public.workshop_hotels
  add column if not exists cancellation_window_days int,
  add column if not exists cancellation_policy text,
  add column if not exists reminder_lead_days int;

do $$ begin
  alter table public.workshop_hotels
    add constraint workshop_hotels_cancellation_policy_check
    check (cancellation_policy is null or cancellation_policy in ('fixed_deadline', 'release_window', 'custom'));
exception when duplicate_object then null;
end $$;

insert into public.scheduling_rules (key, value, value_type, description, updated_at)
values
  ('habit_horizon_edge_weeks', '4', 'int', 'Raise horizon_edge when latest placed habit is fewer than this many weeks ahead of today', now()),
  ('travel_horizon_edge_weeks', '4', 'int', 'Raise horizon_edge when latest travel_blocks placement is fewer than this many weeks ahead of today', now())
on conflict (key) do update set
  value = excluded.value,
  description = excluded.description,
  updated_at = now();
