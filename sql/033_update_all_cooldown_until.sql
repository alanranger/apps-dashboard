-- BAU Monthly (P25): a LIVE run that hit a Squarespace 429 in pre-flight waits here until the 30-min cool-down ends.
alter table public.update_all_runs add column if not exists cooldown_until timestamptz;
