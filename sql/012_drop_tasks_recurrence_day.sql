-- Retire tasks.recurrence_day (added in 009) — MC-43 v2 Part 0b.
-- Habits live in recurring_tasks (the real habit store), projected by
-- /api/mc/habit-projection. tasks.recurrence_day was built on the wrong-source
-- assumption that BAU habits live in tasks.recurrence; that endpoint
-- (/api/mc/recurring-projection) is retired and nothing else reads this column.
-- NOTE: tasks.recurrence is KEPT — MC-7 / MC-11 / MC-26 use it as recurring
-- *tasks* (distinct from BAU habits).
alter table tasks drop column if exists recurrence_day;
