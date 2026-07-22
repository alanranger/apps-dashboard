-- MC-55: Claude-writable terminal statuses (verify lock preserved)
-- Host: alan-chat-rag (igzvwbvgvmzvvzoclufx)

do $$ begin alter type mc_state add value if not exists 'done'; exception when duplicate_object then null; end $$;
do $$ begin alter type mc_state add value if not exists 'superseded'; exception when duplicate_object then null; end $$;
do $$ begin alter type mc_state add value if not exists 'wont_do'; exception when duplicate_object then null; end $$;

alter table tasks add column if not exists close_authorized_by text;
alter table tasks add column if not exists close_authorized_at timestamptz;
alter table tasks add column if not exists close_reason text;
alter table tasks add column if not exists superseded_by_display_id int;

create or replace function mc_block_direct_verified()
returns trigger language plpgsql as $$
begin
  if new.state = 'verified' and old.state is distinct from 'verified' then
    if current_setting('mc.allow_verify', true) is distinct from '1' then
      raise exception 'verified is Alan-only — use mc_alan_verify_task or dashboard verify action';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists mc_tasks_block_verified on tasks;
create trigger mc_tasks_block_verified
  before update of state on tasks
  for each row execute function mc_block_direct_verified();

create or replace function mc_alan_verify_task(p_task_id uuid)
returns tasks language plpgsql security definer set search_path = public as $$
declare v_task tasks%rowtype;
begin
  select * into v_task from tasks where id = p_task_id for update;
  if not found then raise exception 'task not found'; end if;
  if v_task.state <> 'done_claimed' then
    raise exception 'only done_claimed tasks can be verified';
  end if;
  perform set_config('mc.allow_verify', '1', true);
  update tasks set
    state = 'verified', verified_at = now(), sent_back_note = null, last_activity_at = now()
  where id = p_task_id returning * into v_task;
  insert into task_log (task_id, actor, change) values (p_task_id, 'alan', 'verified');
  return v_task;
end;
$$;

create or replace function mc_agent_close_task(
  p_display_id int,
  p_new_state text,
  p_authorized_by text,
  p_reason text,
  p_superseded_by_display_id int default null,
  p_actor text default 'claude'
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_task tasks%rowtype;
  v_actor mc_actor;
  v_log text;
  v_state mc_state;
begin
  if lower(trim(p_new_state)) = 'verified' then
    raise exception 'verified is Alan-only and blocked for agent close';
  end if;
  if lower(trim(p_new_state)) not in ('done', 'superseded', 'wont_do') then
    raise exception 'agent close allows done, superseded, wont_do only (got %)', p_new_state;
  end if;
  if trim(coalesce(p_authorized_by, '')) = '' then raise exception 'p_authorized_by required'; end if;
  if trim(coalesce(p_reason, '')) = '' then raise exception 'p_reason required'; end if;
  if lower(trim(p_new_state)) = 'superseded' and p_superseded_by_display_id is null then
    raise exception 'superseded requires p_superseded_by_display_id';
  end if;

  v_state := lower(trim(p_new_state))::mc_state;
  v_actor := case when lower(p_actor) = 'cursor' then 'cursor'::mc_actor else 'claude'::mc_actor end;

  select * into v_task from tasks where display_id = p_display_id for update;
  if not found then raise exception 'task MC-% not found', p_display_id; end if;
  if v_task.state in ('verified', 'done', 'superseded', 'wont_do') then
    raise exception 'task MC-% already terminal (%)', p_display_id, v_task.state;
  end if;

  update tasks set
    state = v_state,
    close_authorized_by = trim(p_authorized_by),
    close_authorized_at = now(),
    close_reason = trim(p_reason),
    superseded_by_display_id = p_superseded_by_display_id,
    last_activity_at = now()
  where id = v_task.id returning * into v_task;

  v_log := format('closed as %s | authorized by %s | %s', v_state, trim(p_authorized_by), trim(p_reason));
  if p_superseded_by_display_id is not null then
    v_log := v_log || format(' | superseded by MC-%s', p_superseded_by_display_id);
  end if;

  insert into task_log (task_id, actor, change) values (v_task.id, v_actor, v_log);
  insert into task_comments (task_id, author, body_md, kind) values (
    v_task.id, v_actor,
    format('**Status closed:** `%s`%s**Authorized by:** %s%s**Reason:** %s',
      v_state,
      E'\n\n',
      trim(p_authorized_by),
      case when p_superseded_by_display_id is not null
        then format('%s**Superseded by:** MC-%s', E'\n\n', p_superseded_by_display_id)
        else '' end,
      trim(p_reason)),
    'status-close'
  );

  return to_jsonb(v_task);
end;
$$;

grant execute on function mc_agent_close_task(int, text, text, text, int, text) to postgres, authenticated, service_role;
grant execute on function mc_alan_verify_task(uuid) to postgres, authenticated, service_role;
