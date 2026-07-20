-- Mission Control schema + seeds (dedicated Supabase project)
-- Run once in SQL editor after creating the project.
-- Storage: create private bucket "mc-attachments" in Dashboard (or via storage.buckets insert below).

create extension if not exists pgcrypto;

do $$ begin
  create type mc_owner as enum ('alan','claude','cursor','external');
exception when duplicate_object then null; end $$;

do $$ begin
  create type mc_state as enum ('todo','in_progress','waiting','done_claimed','verified');
exception when duplicate_object then null; end $$;

do $$ begin
  create type mc_priority as enum ('p0','p1','p2');
exception when duplicate_object then null; end $$;

do $$ begin
  create type mc_actor as enum ('alan','claude','cursor','external','system');
exception when duplicate_object then null; end $$;

create sequence if not exists mc_task_display_seq;

create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  icon text not null,
  sort int not null default 0,
  active boolean not null default true
);

create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  display_id int not null unique default nextval('mc_task_display_seq'),
  project_id uuid not null references projects(id) on delete cascade,
  title text not null,
  detail_md text,
  owner mc_owner not null default 'alan',
  state mc_state not null default 'todo',
  next_step text,
  due_date date,
  waiting_on text,
  priority mc_priority not null default 'p1',
  depends_on_task_id uuid references tasks(id) on delete set null,
  evidence_url text,
  claimed_by mc_actor,
  claimed_at timestamptz,
  verified_at timestamptz,
  sent_back_note text,
  question_file text,
  response_file text,
  recurrence text,
  last_activity_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists checklist_items (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  label text not null,
  done boolean not null default false,
  sort int not null default 0
);

create table if not exists task_log (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  at timestamptz not null default now(),
  actor mc_actor not null,
  change text not null
);

create table if not exists task_comments (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  at timestamptz not null default now(),
  author mc_actor not null,
  body_md text not null,
  image_urls text[] not null default '{}',
  kind text not null default 'comment'
);

create index if not exists tasks_project_state_idx on tasks(project_id, state);
create index if not exists tasks_state_idx on tasks(state);
create index if not exists task_comments_task_idx on task_comments(task_id, at desc);
create index if not exists task_log_task_idx on task_log(task_id, at desc);

insert into storage.buckets (id, name, public)
values ('mc-attachments', 'mc-attachments', false)
on conflict (id) do nothing;

-- Seeds (skip if projects already present)
do $$
declare
  p_aigeo uuid; p_seo uuid; p_sign uuid; p_fin uuid; p_cite uuid; p_content uuid;
  t_hastings uuid; t_id uuid;
begin
  if exists (select 1 from projects limit 1) then
    raise notice 'Mission Control already seeded — skipping';
    return;
  end if;

  insert into projects (name, icon, sort) values
    ('AI GEO app', 'ti-tool', 1) returning id into p_aigeo;
  insert into projects (name, icon, sort) values
    ('SEO resolution plan', 'ti-target', 2) returning id into p_seo;
  insert into projects (name, icon, sort) values
    ('Sign-off register', 'ti-signature', 3) returning id into p_sign;
  insert into projects (name, icon, sort) values
    ('Finance & rescue', 'ti-coin', 4) returning id into p_fin;
  insert into projects (name, icon, sort) values
    ('AI citations', 'ti-sparkles', 5) returning id into p_cite;
  insert into projects (name, icon, sort) values
    ('Content & marketing', 'ti-speakerphone', 6) returning id into p_content;

  -- AI GEO (MC-1..)
  insert into tasks (project_id, title, owner, state, priority) values
    (p_aigeo, 'Walkthrough: integrity checker', 'claude', 'todo', 'p1'),
    (p_aigeo, 'Walkthrough: Money rebuild', 'claude', 'todo', 'p1'),
    (p_aigeo, 'Walkthrough: weekend page fixes', 'claude', 'todo', 'p1'),
    (p_aigeo, 'Explanations upgrade', 'cursor', 'in_progress', 'p1'),
    (p_aigeo, 'Being-Optimised 401', 'cursor', 'todo', 'p2'),
    (p_aigeo, 'June-orphans reconciliation', 'cursor', 'waiting', 'p1');

  -- SEO
  insert into tasks (project_id, title, owner, state, priority, due_date, recurrence) values
    (p_seo, 'Mon recrawl reviews', 'claude', 'todo', 'p1', '2026-07-27', 'weekly:1');
  insert into tasks (project_id, title, owner, state, priority, due_date) values
    (p_seo, 'Rev-weighting brief', 'claude', 'todo', 'p1', '2026-07-26');
  insert into tasks (project_id, title, owner, state, priority, due_date, waiting_on) values
    (p_seo, 'AI-citation scoping', 'alan', 'todo', 'p1', '2026-07-27', 'w/c 27 Jul');
  insert into tasks (project_id, title, owner, state, priority, waiting_on) values
    (p_seo, '22 amber findings → 0', 'external', 'waiting', 'p1', 'external SEO work');
  insert into tasks (project_id, title, owner, state, priority, due_date, recurrence) values
    (p_seo, 'Money review', 'alan', 'todo', 'p1', '2026-09-01', 'monthly:1');

  -- Sign-offs
  insert into tasks (project_id, title, owner, state, priority, waiting_on) values
    (p_sign, 'Page-3 competitor sign-off', 'alan', 'waiting', 'p1', 'Alan review');
  insert into tasks (project_id, title, owner, state, priority) values
    (p_sign, 'Sign-off: URL Money Pages', 'alan', 'todo', 'p1'),
    (p_sign, 'Sign-off: Traditional SEO', 'alan', 'todo', 'p1'),
    (p_sign, 'Sign-off: Backlinks', 'alan', 'todo', 'p1'),
    (p_sign, 'Sign-off: Portfolio', 'alan', 'todo', 'p1'),
    (p_sign, 'Sign-off: Authority', 'alan', 'todo', 'p1'),
    (p_sign, 'Sign-off: Local & Reviews', 'alan', 'todo', 'p1'),
    (p_sign, 'Sign-off: Revenue Truth re-review', 'alan', 'todo', 'p1'),
    (p_sign, 'Sign-off: History', 'alan', 'todo', 'p1');

  -- Finance
  insert into tasks (project_id, title, owner, state, priority, due_date, waiting_on)
  values (p_fin, 'Hastings decision', 'external', 'waiting', 'p0', '2026-07-23', 'Hastings')
  returning id into t_hastings;

  insert into tasks (project_id, title, owner, state, priority, depends_on_task_id)
  values (p_fin, 'Card move', 'alan', 'todo', 'p1', t_hastings);

  insert into tasks (project_id, title, owner, state, priority, depends_on_task_id)
  values (p_fin, 'Clear-down checklist', 'alan', 'todo', 'p1', t_hastings)
  returning id into t_id;

  insert into checklist_items (task_id, label, sort) values
    (t_id, 'Overdraft → 0', 1),
    (t_id, '3 cards cleared + closed', 2),
    (t_id, 'Buffer moved', 3),
    (t_id, 'Limits reduced', 4);

  insert into tasks (project_id, title, owner, state, priority, waiting_on) values
    (p_fin, 'JaJa promo date', 'alan', 'waiting', 'p1', 'promo window');

  -- AI citations
  insert into tasks (project_id, title, owner, state, priority) values
    (p_cite, 'Scoping session', 'claude', 'todo', 'p1');

  -- Content
  insert into tasks (project_id, title, owner, state, priority, recurrence) values
    (p_content, 'Light & Logic next issue', 'alan', 'todo', 'p1', 'monthly:1');
  insert into tasks (project_id, title, owner, state, priority) values
    (p_content, 'Applied Learning next article', 'claude', 'todo', 'p1');
  insert into tasks (project_id, title, owner, state, priority) values
    (p_content, 'JLR comeback next step', 'alan', 'todo', 'p2');
end $$;
