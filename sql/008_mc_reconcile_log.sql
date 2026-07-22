-- Calendar→DB due-date reconcile audit log (apply-side only; app never reads Calendar).
-- Written by POST /api/mc/reconcile-due-dates. Never deleted by the app.
create table if not exists mc_reconcile_log (
  id uuid primary key default gen_random_uuid(),
  run_at timestamptz not null default now(),
  display_id int,
  old_due_date date,
  new_due_date date,
  result text,               -- updated | no_change | unmatched
  source text,
  calendar_event_id text
);
create index if not exists mc_reconcile_log_run_at_idx on mc_reconcile_log (run_at desc);
