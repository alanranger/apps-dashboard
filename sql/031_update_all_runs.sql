-- One-button "Update all" runner: one row per run, one row per step. Service role only (RLS on, no policies).
create table if not exists public.update_all_runs (
  id uuid primary key default gen_random_uuid(),
  mode text not null default 'dry' check (mode in ('dry', 'live')),
  status text not null default 'requested' check (status in ('requested', 'running', 'succeeded', 'warned', 'failed', 'cancelled')),
  requested_by text,
  requested_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  current_step text,
  resume_from text,
  runner_host text,
  options jsonb not null default '{}'::jsonb,
  summary jsonb,
  needs_alan jsonb not null default '[]'::jsonb,
  error text
);

create table if not exists public.update_all_steps (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.update_all_runs(id) on delete cascade,
  step_id text not null,
  ord integer not null,
  name text not null,
  status text not null default 'pending' check (status in ('pending', 'running', 'ok', 'warn', 'fail', 'skipped')),
  attempt integer not null default 0,
  started_at timestamptz,
  finished_at timestamptz,
  duration_ms integer,
  counts jsonb not null default '{}'::jsonb,
  outputs jsonb not null default '[]'::jsonb,
  warnings jsonb not null default '[]'::jsonb,
  error text,
  unique (run_id, step_id)
);

create index if not exists update_all_runs_requested_idx on public.update_all_runs (status, requested_at desc);
create index if not exists update_all_steps_run_idx on public.update_all_steps (run_id, ord);

alter table public.update_all_runs enable row level security;
alter table public.update_all_steps enable row level security;
