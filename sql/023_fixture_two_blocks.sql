-- Two flanking MC ⚽ blocks per fixture (Before / After), not one continuous span.
-- Match stays on Ipswich feed only. Flanks are informational markers on Primary.

alter table public.fixture_blocks
  add column if not exists before_event_id text,
  add column if not exists after_event_id text;

comment on column public.fixture_blocks.calendar_event_id is
  'Legacy single-block id. Prefer before_event_id + after_event_id (2026-07-25 two-block model).';
comment on column public.fixture_blocks.before_event_id is
  'Primary calendar event id for MC ⚽ Before block (S−buffer → S).';
comment on column public.fixture_blocks.after_event_id is
  'Primary calendar event id for MC ⚽ After block (E → E+buffer).';

update public.scheduling_rules
set description = 'Length in minutes of EACH flanking MC ⚽ block (Before = S−N→S, After = E→E+N). Not a continuous ±N span over the match.',
    updated_at = now()
where key = 'fixture_buffer_min';

update public.scheduling_rules
set description = 'Prefix for informational Ipswich fixture flank blocks (MC ⚽ Before: / MC ⚽ After:). Never binding; never raises a rule_breach.',
    updated_at = now()
where key = 'title_prefix_fixture';
