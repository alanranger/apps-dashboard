-- page_html keeps exactly one row per page (Alan 4 Nov). Applied AFTER the one-off prune to the newest row per url:
--   * unique key on url (Chat AI Bot api/ingest.js upserts on url: a re-ingest updates the row in place);
--   * the daily clean-up no longer deletes by age (that could remove a page's only copy): it removes only rows that
--     are not their page's newest — none, once the unique key exists;
--   * BAU B/H Undo restores page_html as each backed-up url's newest backed-up row (backups taken before this change
--     hold several versions per url, which a unique url key would refuse).

create unique index if not exists page_html_url_key on public.page_html (url);

select cron.alter_job(
  (select jobid from cron.job where jobname = 'daily_page_html_cleanup'),
  command := $cmd$DELETE FROM page_html p WHERE EXISTS (SELECT 1 FROM page_html q WHERE q.url = p.url AND (q.updated_at, q.id) > (p.updated_at, p.id));$cmd$
);

create or replace function public.bau_restore_page_html(p_run text, p_mode text default 'live')
returns jsonb language plpgsql security definer set search_path = public set statement_timeout = '5min' as $$
declare n record; src text; bk text; urls text; sets text; removed bigint; restored bigint;
begin
  select * into n from public.bau_bk_names(p_run, p_mode);
  src := n.src_prefix || 'page_html'; bk := n.bk_prefix || p_run || '_page_html'; urls := n.bk_prefix || p_run || '_urls';
  if to_regclass('public.' || bk) is null then raise exception 'bau_restore_page_html: backup % does not exist', bk; end if;
  execute format('create temp table _bau_newest_html on commit drop as select distinct on (url) * from %I order by url, updated_at desc nulls last, id desc', bk);
  execute format('delete from %I s where s.url in (select url from %I) and not exists (select 1 from _bau_newest_html b where b.id = s.id)', src, urls);
  get diagnostics removed = row_count;
  select string_agg(format('%I = excluded.%I', column_name, column_name), ', ' order by ordinal_position) into sets
    from information_schema.columns where table_schema = 'public' and table_name = src and column_name <> 'id';
  execute format('insert into %I select b.* from _bau_newest_html b where not exists (select 1 from %I s where s.id = b.id and row(s.*) is not distinct from row(b.*)) on conflict (id) do update set %s',
    src, src, sets);
  get diagnostics restored = row_count;
  return jsonb_build_object('table', 'page_html', 'removed_since_backup', removed, 'restored', restored);
end $$;

create or replace function public.bau_restore_part(p_run text, p_table text, p_mode text default 'live')
returns jsonb language plpgsql security definer set search_path = public set statement_timeout = '5min' as $$
declare n record; pk text := public.bau_bk_pk(p_table); src text; bk text; urls text; sets text; removed bigint; restored bigint;
begin
  if p_table = 'page_html' then return public.bau_restore_page_html(p_run, p_mode); end if;
  select * into n from public.bau_bk_names(p_run, p_mode);
  if pk is null then raise exception 'bau_restore_part: unknown table %', p_table; end if;
  src := n.src_prefix || p_table; bk := n.bk_prefix || p_run || '_' || p_table; urls := n.bk_prefix || p_run || '_urls';
  if to_regclass('public.' || bk) is null then raise exception 'bau_restore_part: backup % does not exist', bk; end if;
  if p_table = 'page_chunks' then
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

revoke all on function public.bau_restore_page_html(text, text) from public, anon, authenticated;
grant execute on function public.bau_restore_page_html(text, text) to service_role;
