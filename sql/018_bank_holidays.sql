-- Deterministic, auditable UK bank-holiday source for the MC scheduler.
-- Replaces reliance on the subscribed "UK Holidays" Google Calendar feed, which
-- returns zero events and is indistinguishable from "no holidays this period".
-- Seeded from GOV.UK (https://www.gov.uk/bank-holidays.json, england-and-wales
-- division), refreshed on the existing cron. Covers substitute days (e.g. the
-- 28 Dec 2026 Boxing Day substitute) that the computed last-Monday calculator misses.

CREATE TABLE IF NOT EXISTS public.bank_holidays (
  holiday_date  date NOT NULL,
  division      text NOT NULL DEFAULT 'england-and-wales',
  title         text NOT NULL,
  is_substitute boolean NOT NULL DEFAULT false,
  source        text NOT NULL DEFAULT 'gov.uk',
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (holiday_date, division)
);

COMMENT ON TABLE public.bank_holidays IS
  'Canonical UK bank holidays for the MC scheduler (exclude_bank_holidays rule). Seeded from GOV.UK england-and-wales division; refreshed on the diary cron. An empty result over a future range is a FAULT, not "no holidays".';

CREATE INDEX IF NOT EXISTS bank_holidays_date_idx ON public.bank_holidays (holiday_date);
