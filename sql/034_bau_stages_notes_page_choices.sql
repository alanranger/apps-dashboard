-- BAU Monthly batch 7.
-- Per-stage runs: stages = the stage letters this run covers (null = Run all); stage_results = per stage
-- { status, mode, finished_at, sandbox, published[], commit, ingest } written by the PC runner.
alter table public.update_all_runs add column if not exists stages text[];
alter table public.update_all_runs add column if not exists stage_results jsonb not null default '{}'::jsonb;

-- Readable step results: one plain sentence, levelled notes (info / check / problem) and collapsed details.
alter table public.update_all_steps add column if not exists plain text;
alter table public.update_all_steps add column if not exists notes jsonb not null default '[]'::jsonb;
alter table public.update_all_steps add column if not exists details jsonb not null default '[]'::jsonb;

-- P16: Alan's choice for a page new in 06 (service / landing / exclude), so a page is never asked about twice.
create table if not exists public.bau_page_choices (
  url text primary key,
  choice text not null check (choice in ('service', 'landing', 'exclude')),
  suggested text,
  decided_by text,
  decided_at timestamptz not null default now()
);
alter table public.bau_page_choices enable row level security;
