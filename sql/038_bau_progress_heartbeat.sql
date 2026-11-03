-- BAU progress window (Alan 3 Nov): the runner reports sub-progress, a heartbeat and a log line list on the run row,
-- and its idle checks on update_all_runner_state (queued countdown "next check in N s"). Additive only.
alter table public.update_all_runs add column if not exists progress jsonb;
alter table public.update_all_runs add column if not exists heartbeat_at timestamptz;
alter table public.update_all_runs add column if not exists log jsonb;

create table if not exists public.update_all_runner_state (
  id text primary key,
  checked_at timestamptz not null default now(),
  host text,
  live_switch boolean,
  busy_run uuid
);
alter table public.update_all_runner_state enable row level security;
