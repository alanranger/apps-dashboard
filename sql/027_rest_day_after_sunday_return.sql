-- Editable Alan rule: Monday rest only after Sunday travel-back.
-- Default true. Safe to re-run.

insert into public.scheduling_rules (key, value)
values ('rest_day_after_sunday_return', 'true')
on conflict (key) do update set value = excluded.value;
