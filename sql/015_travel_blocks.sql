-- Travel / buffer placements (not habits). Applied remotely 2026-07-24.
-- Claude backfills calendar_event_id rows; detector reads this table for coverage.

create table if not exists public.travel_blocks (
  id uuid primary key default gen_random_uuid(),
  block_type text not null
    check (block_type in ('travel_out', 'travel_back', 'travel_leg', 'prep', 'decompress')),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  calendar_event_id text not null,
  venue_name text,
  workshop_title text,
  workshop_start timestamptz,
  workshop_row_key text,
  leg_from text,
  leg_to text,
  drive_minutes_used int,
  drive_time_verified_at timestamptz,
  departure_traffic_model text,
  created_by text not null default 'claude',
  created_at timestamptz not null default now(),
  constraint travel_blocks_calendar_event_id_unique unique (calendar_event_id)
);

create index if not exists travel_blocks_workshop_start_idx
  on public.travel_blocks (workshop_start);

create index if not exists travel_blocks_type_start_idx
  on public.travel_blocks (block_type, workshop_start);

create index if not exists travel_blocks_venue_name_idx
  on public.travel_blocks (venue_name);

create index if not exists travel_blocks_workshop_row_key_idx
  on public.travel_blocks (workshop_row_key);
