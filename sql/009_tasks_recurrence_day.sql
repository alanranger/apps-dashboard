-- Anchor day for recurring MC tasks so weekly:N / monthly:N can project into a
-- calendar horizon (see /api/mc/recurring-projection). Nullable; endpoint falls
-- back to the task's due_date weekday/day-of-month, else Monday / the 1st.
--   weekly:N  -> 1-7 = Mon-Sun
--   monthly:N -> 1-31 = day of month
alter table tasks add column if not exists recurrence_day int;

-- Known BAU anchors (idempotent).
update tasks set recurrence_day = 1  where display_id = 49 and recurrence_day is distinct from 1;  -- booking sheet -> 1st
update tasks set recurrence_day = 3  where display_id = 50 and recurrence_day is distinct from 3;  -- bank rec -> 3rd
update tasks set recurrence_day = 1  where display_id = 7  and recurrence_day is distinct from 1;  -- Mon recrawl -> Monday
update tasks set recurrence_day = 1  where display_id = 11 and recurrence_day is distinct from 1;  -- money review -> its due day (1st)
update tasks set recurrence_day = 24 where display_id = 26 and recurrence_day is distinct from 24; -- Light & Logic -> its due day (24th)
