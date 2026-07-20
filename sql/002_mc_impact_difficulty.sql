-- Impact × Difficulty for Mission Control priority matrix (Money Pages style)
do $$ begin
  create type mc_level as enum ('HIGH','MEDIUM','LOW');
exception when duplicate_object then null; end $$;

alter table tasks add column if not exists impact mc_level not null default 'MEDIUM';
alter table tasks add column if not exists difficulty mc_level not null default 'MEDIUM';
