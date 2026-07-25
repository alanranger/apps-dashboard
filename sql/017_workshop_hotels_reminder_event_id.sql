-- Tie-back for MC ⏰ hotel deadline / room-release reminders.
ALTER TABLE public.workshop_hotels
  ADD COLUMN IF NOT EXISTS reminder_event_id text;

COMMENT ON COLUMN public.workshop_hotels.reminder_event_id IS
  'Google Calendar event id for the MC ⏰ deadline/release reminder. Tie-back for busy-map identity; colorId=10 alone is not enough.';
