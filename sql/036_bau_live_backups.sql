-- BAU Monthly Live, stages B / H (Claude/Alan 3 Nov, design + step 5): automatic backups before the first database
-- write, and an exact restore for Undo. Backups are kept (Alan: archive, don't delete): bau_bk_<run8>_<table>.
--   full copies:        csv_metadata, page_entities, event_product_links_auto
--   affected rows only: page_chunks, page_html (rows whose url is in the run's url list, saved as bau_bk_<run8>_urls)
-- Restore never empties a table (csv_metadata ids are referenced ON DELETE SET NULL by page_chunks / page_entities):
--   1. rows added since the backup go (page_chunks / page_html: only within the backed-up urls);
--   2. every backed-up row comes back exactly (upsert on the primary key).
-- p_test = true works on bau_bk_test_src_* sample tables (the restore proof), never on the real tables.

create or replace function public.bau_backup(p_run text, p_urls text[], p_test boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  tables constant text[] := array['csv_metadata', 'page_entities', 'event_product_links_auto', 'page_chunks', 'page_html'];
  url_tables constant text[] := array['page_chunks', 'page_html'];
  pre_src text := case when p_test then 'bau_bk_test_src_' else '' end;
  pre_bk text := case when p_test then 'bau_bk_test_' else 'bau_bk_' end;
  t text; bk text; n bigint; out jsonb := '{}'::jsonb;
begin
  if p_run !~ '^[a-z0-9]{8}$' then raise exception 'bau_backup: the run id must be 8 lowercase letters or digits'; end if;
  execute format('create table %I (url text primary key)', pre_bk || p_run || '_urls');
  execute format('insert into %I select distinct u from unnest($1) u where u is not null', pre_bk || p_run || '_urls') using p_urls;
  foreach t in array tables loop
    bk := pre_bk || p_run || '_' || t;
    execute format('create table %I (like %I)', bk, pre_src || t);
    if t = any(url_tables) then
      execute format('insert into %I select * from %I where url = any($1)', bk, pre_src || t) using p_urls;
    else
      execute format('insert into %I select * from %I', bk, pre_src || t);
    end if;
    execute format('select count(*) from %I', bk) into n;
    out := out || jsonb_build_object(bk, n);
  end loop;
  return out || jsonb_build_object(pre_bk || p_run || '_urls', coalesce(array_length(p_urls, 1), 0));
end $$;

create or replace function public.bau_restore(p_run text, p_test boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  spec constant text[] := array['csv_metadata:id:full', 'page_entities:id:full', 'event_product_links_auto:event_url:full', 'page_chunks:id:url', 'page_html:id:url'];
  pre_src text := case when p_test then 'bau_bk_test_src_' else '' end;
  pre_bk text := case when p_test then 'bau_bk_test_' else 'bau_bk_' end;
  urls text := pre_bk || p_run || '_urls';
  s text; t text; pk text; scope text; src text; bk text; sets text; removed bigint; restored bigint; out jsonb := '{}'::jsonb;
begin
  if p_run !~ '^[a-z0-9]{8}$' then raise exception 'bau_restore: the run id must be 8 lowercase letters or digits'; end if;
  foreach s in array spec loop
    t := split_part(s, ':', 1); pk := split_part(s, ':', 2); scope := split_part(s, ':', 3);
    src := pre_src || t; bk := pre_bk || p_run || '_' || t;
    if to_regclass('public.' || bk) is null then raise exception 'bau_restore: backup % does not exist', bk; end if;
    if scope = 'full' then
      execute format('delete from %I s where not exists (select 1 from %I b where b.%I = s.%I)', src, bk, pk, pk);
    else
      execute format('delete from %I s where s.url in (select url from %I) and not exists (select 1 from %I b where b.%I = s.%I)', src, urls, bk, pk, pk);
    end if;
    get diagnostics removed = row_count;
    select string_agg(format('%I = excluded.%I', column_name, column_name), ', ' order by ordinal_position) into sets
      from information_schema.columns where table_schema = 'public' and table_name = src and column_name <> pk;
    execute format('insert into %I select * from %I on conflict (%I) do update set %s', src, bk, pk, sets);
    get diagnostics restored = row_count;
    out := out || jsonb_build_object(t, jsonb_build_object('removed_since_backup', removed, 'restored', restored));
  end loop;
  return out;
end $$;

-- Restore proof only: 5-row sample copies of the real tables (with their primary keys), named bau_bk_test_src_*.
create or replace function public.bau_test_setup()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  spec constant text[] := array['csv_metadata:id', 'page_entities:id', 'event_product_links_auto:event_url', 'page_chunks:id', 'page_html:id'];
  s text; t text; pk text; n bigint; out jsonb := '{}'::jsonb;
begin
  foreach s in array spec loop
    t := split_part(s, ':', 1); pk := split_part(s, ':', 2);
    execute format('drop table if exists %I', 'bau_bk_test_src_' || t);
    execute format('create table %I (like %I including defaults including constraints including indexes)', 'bau_bk_test_src_' || t, t);
    if t in ('page_chunks', 'page_html') then
      execute format('insert into %I select * from %I where url in (select distinct url from %I where url is not null order by url limit 5)', 'bau_bk_test_src_' || t, t, t);
    else
      execute format('insert into %I select * from %I order by %I limit 5', 'bau_bk_test_src_' || t, t, pk);
    end if;
    execute format('select count(*) from %I', 'bau_bk_test_src_' || t) into n;
    out := out || jsonb_build_object('bau_bk_test_src_' || t, n);
  end loop;
  return out;
end $$;

-- Fingerprint of a table's full contents (restore proof: before == after).
create or replace function public.bau_table_fingerprint(p_table text)
returns text language plpgsql security definer set search_path = public as $$
declare h text;
begin
  if p_table !~ '^(bau_bk_test_src_|bau_bk_test_)[a-z0-9_]+$' then raise exception 'bau_table_fingerprint: test tables only'; end if;
  execute format('select md5(coalesce(string_agg(t::text, ''|'' order by t::text), '''')) from %I t', p_table) into h;
  return h;
end $$;

-- Removes only the restore-proof tables (bau_bk_test_*); real backups bau_bk_<run8>_* are never dropped.
create or replace function public.bau_test_drop()
returns int language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  for r in select tablename from pg_tables where schemaname = 'public' and tablename like 'bau\_bk\_test\_%' loop
    execute format('drop table %I', r.tablename);
    n := n + 1;
  end loop;
  return n;
end $$;

revoke all on function public.bau_backup(text, text[], boolean) from public, anon, authenticated;
revoke all on function public.bau_restore(text, boolean) from public, anon, authenticated;
revoke all on function public.bau_test_setup() from public, anon, authenticated;
revoke all on function public.bau_table_fingerprint(text) from public, anon, authenticated;
revoke all on function public.bau_test_drop() from public, anon, authenticated;
grant execute on function public.bau_backup(text, text[], boolean) to service_role;
grant execute on function public.bau_restore(text, boolean) to service_role;
grant execute on function public.bau_test_setup() to service_role;
grant execute on function public.bau_table_fingerprint(text) to service_role;
grant execute on function public.bau_test_drop() to service_role;
