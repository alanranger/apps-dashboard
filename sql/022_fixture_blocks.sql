-- Fixture blocks (Ipswich Town). Informational MC ⚽ blocks — NOT binding.
-- A fixture never displaces/blocks/flags a class or MC admin, never causes a roll,
-- never raises a rule_breach. It exists so Alan can see the match. Alan watches at
-- home (home + away alike) so there is no travel. Retirement re-keys on
-- fixture_event_id every run. Approved shape (2026-07-25 build brief).

create table if not exists public.fixture_blocks (
  id uuid primary key default gen_random_uuid(),
  fixture_event_id text not null unique,   -- Ipswich calendar event id (feed key)
  calendar_event_id text,                  -- MC ⚽ block once Claude places it
  title text,                              -- e.g. "⚽ Ipswich Town vs Coventry City"
  fixture_start timestamptz not null,      -- kick-off
  fixture_end timestamptz not null,        -- stated end
  block_start timestamptz not null,        -- kick-off − buffer_min
  block_end timestamptz not null,          -- end + buffer_min
  buffer_min int not null default 60,
  status text not null default 'active'
    check (status in ('active', 'retired')),
  created_by text not null default 'detector',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists fixture_blocks_status_idx
  on public.fixture_blocks (status);

create index if not exists fixture_blocks_fixture_start_idx
  on public.fixture_blocks (fixture_start);

-- Fifth title prefix (⚽). Kept distinct from ⏳ prep/decompress so busy-map and
-- retirement semantics stay honest.
insert into public.scheduling_rules (key, value, value_type, description)
values (
  'title_prefix_fixture', 'MC ⚽', 'text',
  'Prefix for informational Ipswich fixture blocks (kick-off − fixture_buffer_min → end + fixture_buffer_min). Never binding; never raises a rule_breach.'
)
on conflict (key) do update
  set value = excluded.value,
      value_type = excluded.value_type,
      description = excluded.description,
      updated_at = now();

-- How far ahead to place fixtures. Season feed runs ~11 months, so the 12-week
-- travel horizon is too short; use a season-length horizon (workshop-derived spirit).
insert into public.scheduling_rules (key, value, value_type, description)
values (
  'fixture_horizon_weeks', '60', 'int',
  'Weeks ahead the detector places Ipswich fixture blocks. Season feed spans ~11 months; 60w covers it with headroom.'
)
on conflict (key) do update
  set value = excluded.value,
      value_type = excluded.value_type,
      description = excluded.description,
      updated_at = now();
