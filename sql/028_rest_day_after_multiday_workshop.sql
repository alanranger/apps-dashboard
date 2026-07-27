-- Rest day = day after last day of each multi-day workshop event.
-- Replaces wrong Sunday-return travel_back key.
-- Safe to re-run.

insert into public.scheduling_rules (key, value)
values ('rest_day_after_multiday_workshop', 'true')
on conflict (key) do update set value = excluded.value;

delete from public.scheduling_rules
where key = 'rest_day_after_sunday_return';
