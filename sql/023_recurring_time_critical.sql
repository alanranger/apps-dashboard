-- §7b backward roll: time_critical flag on recurring_tasks.
-- When missed_habit_direction = backward_if_time_critical, a time-critical habit
-- whose ideal day is blocked rolls to the nearest PRIOR legal slot rather than the
-- next forward day; flexible habits keep the forward roll. Editable in the Recurring
-- tab so Alan can reclassify without a code change. Alan's ruling (2026-07-25 brief).

alter table public.recurring_tasks
  add column if not exists time_critical boolean not null default false;

-- Alan's classification — TIME-CRITICAL (roll EARLIER when the ideal day is blocked).
update public.recurring_tasks
  set time_critical = true, updated_at = now()
  where title in (
    'Send Out Joining Details',
    'Booking Sheet, Month End Update',
    'Hotel bookings check (Claude)',
    'Hotel bookings — Alan actions'
  );

-- Everything else stays flexible (forward roll). Explicit for clarity.
update public.recurring_tasks
  set time_critical = false, updated_at = now()
  where title not in (
    'Send Out Joining Details',
    'Booking Sheet, Month End Update',
    'Hotel bookings check (Claude)',
    'Hotel bookings — Alan actions'
  );
