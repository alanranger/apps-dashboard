-- workshop_hotels lifecycle status. Previously a cancelled booking could only be
-- recorded in notes + reminder_placed=true (a hack that made a cancelled booking
-- look serviced). This gives the hotel_cancelled_but_registered detector somewhere
-- to write its answer, and lets the gap scan skip cancelled / awaiting rows.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'hotel_status') THEN
    CREATE TYPE hotel_status AS ENUM ('active', 'cancelled', 'awaiting_booking');
  END IF;
END $$;

ALTER TABLE public.workshop_hotels
  ADD COLUMN IF NOT EXISTS status hotel_status NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS cancelled_at date;

COMMENT ON COLUMN public.workshop_hotels.status IS
  'active | cancelled | awaiting_booking. cancelled = booking dropped (keep row for history, never raise deadline gaps). awaiting_booking = a known trip whose hotel is not yet booked (empty row expected, suppress as a gap).';
COMMENT ON COLUMN public.workshop_hotels.cancelled_at IS
  'Date the booking was cancelled (status=cancelled).';
