-- BAU backup retention (Alan 3 Nov): a B / H backup is kept for the 14-day undo window, only the latest per stage,
-- never while its stage is mid-undo or failed awaiting retry. The PC runner decides (runner/bau-retention.mjs) and drops
-- through bau_backup_drop, which only ever touches bau_bk_<run8 hex>_* and bau_bk_test* tables.

create or replace function public.bau_backup_inventory()
returns table (table_name text, run8 text, kind text, bytes bigint) language sql security definer set search_path = public as $$
  select t.tablename::text,
         substring(t.tablename from '^bau_bk_([0-9a-f]{8})_')::text,
         case when t.tablename like 'bau\_bk\_test%' then 'test' else 'backup' end,
         pg_total_relation_size(format('public.%I', t.tablename)::regclass)
  from pg_tables t
  where t.schemaname = 'public' and (t.tablename ~ '^bau_bk_[0-9a-f]{8}_[a-z_]+$' or t.tablename like 'bau\_bk\_test%')
$$;

create or replace function public.bau_backup_drop(p_table text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if p_table !~ '^bau_bk_([0-9a-f]{8}_[a-z_]+|test[a-z0-9_]*)$' then
    raise exception 'bau_backup_drop: only bau_bk_<run8>_* or bau_bk_test* tables (got %)', p_table;
  end if;
  execute format('drop table if exists %I', p_table);
  return true;
end $$;

-- Monday brief System health: "BAU backups: N tables, X MB".
create or replace function public.bau_backup_stats()
returns jsonb language sql security definer set search_path = public as $$
  select jsonb_build_object('tables', count(*), 'bytes', coalesce(sum(bytes), 0)) from public.bau_backup_inventory()
$$;

revoke all on function public.bau_backup_inventory() from public, anon, authenticated;
revoke all on function public.bau_backup_drop(text) from public, anon, authenticated;
revoke all on function public.bau_backup_stats() from public, anon, authenticated;
grant execute on function public.bau_backup_inventory() to service_role;
grant execute on function public.bau_backup_drop(text) to service_role;
grant execute on function public.bau_backup_stats() to service_role;
