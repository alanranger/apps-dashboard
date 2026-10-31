-- Update all: Alan chooses per run whether step 13 (① full audit) runs. Default on.
alter table public.update_all_runs add column if not exists include_audit boolean not null default true;
