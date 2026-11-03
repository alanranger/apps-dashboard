-- BAU Live B / H backups at full scale (live B b00c597b, 3 Nov): one bau_backup call copied ~344 MB of page_html
-- (3,513 rows, 520 urls) inside the 8 s REST statement timeout and was cancelled. Now:
--   * one call per table (page_html in url chunks from the runner), each with its own 5 min statement_timeout;
--   * every call is idempotent: create-if-missing with the table's primary key, insert ... on conflict do nothing;
--   * bau_backup_done marks a finished backup; a retry (Resume) never retakes it, so the backup stays the pre-write state;
--   * restore per table too, skipping rows that are already identical (the html is not rewritten when unchanged).
-- Modes: live (real tables → bau_bk_<run8>_*), test (bau_bk_test_src_* → bau_bk_test_*, the 5-row restore proof),
--        proof (real tables read only → bau_bk_test2_*), proof_restore (bau_bk_test2_src_* ← bau_bk_test2_*).

create or replace function public.bau_bk_names(p_run text, p_mode text, out src_prefix text, out bk_prefix text)
language plpgsql immutable as $$
begin
  if p_run !~ '^[a-z0-9]{8}$' then raise exception 'bau: the run id must be 8 lowercase letters or digits'; end if;
  src_prefix := case p_mode when 'test' then 'bau_bk_test_src_' when 'proof_restore' then 'bau_bk_test2_src_' else '' end;
  bk_prefix := case p_mode when 'live' then 'bau_bk_' when 'test' then 'bau_bk_test_' when 'proof' then 'bau_bk_test2_' when 'proof_restore' then 'bau_bk_test2_' end;
  if bk_prefix is null then raise exception 'bau: unknown mode %', p_mode; end if;
end $$;

create or replace function public.bau_bk_pk(p_table text) returns text language sql immutable as $$
  select case p_table when 'csv_metadata' then 'id' when 'page_entities' then 'id' when 'event_product_links_auto' then 'event_url'
    when 'page_chunks' then 'id' when 'page_html' then 'id' end $$;

create or replace function public.bau_backup_part(p_run text, p_table text, p_urls text[] default null, p_mode text default 'live')
returns jsonb language plpgsql security definer set search_path = public set statement_timeout = '5min' as $$
declare n record; pk text := public.bau_bk_pk(p_table); bk text; src text; added bigint; total bigint;
begin
  select * into n from public.bau_bk_names(p_run, p_mode);
  if p_table = 'urls' then
    bk := n.bk_prefix || p_run || '_urls';
    execute format('create table if not exists %I (url text primary key)', bk);
    execute format('insert into %I select distinct u from unnest($1) u where u is not null on conflict do nothing', bk) using p_urls;
  elsif pk is null then
    raise exception 'bau_backup_part: unknown table %', p_table;
  else
    src := n.src_prefix || p_table; bk := n.bk_prefix || p_run || '_' || p_table;
    if to_regclass('public.' || bk) is null then
      execute format('create table %I (like %I)', bk, src);
      execute format('alter table %I add primary key (%I)', bk, pk);
    end if;
    if p_table in ('page_chunks', 'page_html') then
      execute format('insert into %I select * from %I where url = any($1) on conflict (%I) do nothing', bk, src, pk) using p_urls;
    else
      execute format('insert into %I select * from %I on conflict (%I) do nothing', bk, src, pk);
    end if;
  end if;
  get diagnostics added = row_count;
  execute format('select count(*) from %I', bk) into total;
  return jsonb_build_object('table', bk, 'added', added, 'rows', total);
end $$;

-- p_set = true marks the backup finished (after every table); always returns whether it is finished.
create or replace function public.bau_backup_done(p_run text, p_mode text default 'live', p_set boolean default false)
returns boolean language plpgsql security definer set search_path = public as $$
declare n record; marker text;
begin
  select * into n from public.bau_bk_names(p_run, p_mode);
  marker := n.bk_prefix || p_run || '_done';
  if p_set then execute format('create table if not exists %I (finished_at timestamptz default now())', marker); end if;
  return to_regclass('public.' || marker) is not null;
end $$;

create or replace function public.bau_restore_part(p_run text, p_table text, p_mode text default 'live')
returns jsonb language plpgsql security definer set search_path = public set statement_timeout = '5min' as $$
declare n record; pk text := public.bau_bk_pk(p_table); src text; bk text; urls text; sets text; removed bigint; restored bigint;
begin
  select * into n from public.bau_bk_names(p_run, p_mode);
  if pk is null then raise exception 'bau_restore_part: unknown table %', p_table; end if;
  src := n.src_prefix || p_table; bk := n.bk_prefix || p_run || '_' || p_table; urls := n.bk_prefix || p_run || '_urls';
  if to_regclass('public.' || bk) is null then raise exception 'bau_restore_part: backup % does not exist', bk; end if;
  if p_table in ('page_chunks', 'page_html') then
    execute format('delete from %I s where s.url in (select url from %I) and not exists (select 1 from %I b where b.%I = s.%I)', src, urls, bk, pk, pk);
  else
    execute format('delete from %I s where not exists (select 1 from %I b where b.%I = s.%I)', src, bk, pk, pk);
  end if;
  get diagnostics removed = row_count;
  select string_agg(format('%I = excluded.%I', column_name, column_name), ', ' order by ordinal_position) into sets
    from information_schema.columns where table_schema = 'public' and table_name = src and column_name <> pk;
  execute format('insert into %I select b.* from %I b where not exists (select 1 from %I s where s.%I = b.%I and row(s.*) is not distinct from row(b.*)) on conflict (%I) do update set %s',
    src, bk, src, pk, pk, pk, sets);
  get diagnostics restored = row_count;
  return jsonb_build_object('table', p_table, 'removed_since_backup', removed, 'restored', restored);
end $$;

-- Full-scale restore proof: copies of the real tables limited to the backed-up urls (page_chunks / page_html), named bau_bk_test2_src_*.
create or replace function public.bau_test2_src(p_run text, p_table text)
returns bigint language plpgsql security definer set search_path = public set statement_timeout = '5min' as $$
declare pk text := public.bau_bk_pk(p_table); src text := 'bau_bk_test2_src_' || p_table; n bigint;
begin
  if p_run !~ '^[a-z0-9]{8}$' or pk is null then raise exception 'bau_test2_src: bad run or table'; end if;
  execute format('drop table if exists %I', src);
  execute format('create table %I (like %I)', src, p_table);
  execute format('alter table %I add primary key (%I)', src, pk);
  if p_table in ('page_chunks', 'page_html') then
    execute format('insert into %I select * from %I where url in (select url from %I)', src, p_table, 'bau_bk_test2_' || p_run || '_urls');
  else
    execute format('insert into %I select * from %I', src, p_table);
  end if;
  get diagnostics n = row_count;
  return n;
end $$;

-- Removes only proof tables (bau_bk_test_* and bau_bk_test2_*); real backups bau_bk_<run8>_* (hex run ids) are never dropped.
create or replace function public.bau_test_drop()
returns int language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  for r in select tablename from pg_tables where schemaname = 'public' and (tablename like 'bau\_bk\_test\_%' or tablename like 'bau\_bk\_test2\_%') loop
    execute format('drop table %I', r.tablename);
    n := n + 1;
  end loop;
  return n;
end $$;

revoke all on function public.bau_bk_names(text, text) from public, anon, authenticated;
revoke all on function public.bau_backup_part(text, text, text[], text) from public, anon, authenticated;
revoke all on function public.bau_backup_done(text, text, boolean) from public, anon, authenticated;
revoke all on function public.bau_restore_part(text, text, text) from public, anon, authenticated;
revoke all on function public.bau_test2_src(text, text) from public, anon, authenticated;
grant execute on function public.bau_backup_part(text, text, text[], text) to service_role;
grant execute on function public.bau_backup_done(text, text, boolean) to service_role;
grant execute on function public.bau_restore_part(text, text, text) to service_role;
grant execute on function public.bau_test2_src(text, text) to service_role;
