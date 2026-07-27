-- Teaching/client whole-day block — OFF until baseline is stable.
-- When true: Workshops/Lessons/Zoom 1-2-1 days become teaching_day
-- (banner, placer hard-block, zero admin capacity).
-- Safe to re-run.

insert into public.scheduling_rules (key, value)
values ('teaching_day_whole_day_block', 'false')
on conflict (key) do update set value = excluded.value;
