-- Run log for the diary-drift detector, so the Scheduling panel can show a
-- readout: last run (auto/manual), coverage range, blocks adjudicated, and
-- per-source health. The bank-holiday lesson made permanent — a dead input
-- (holidays: "no data") must be visible, never indistinguishable from a clean pass.

CREATE TABLE IF NOT EXISTS public.diary_check_runs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ran_at             timestamptz NOT NULL DEFAULT now(),
  mode               text NOT NULL DEFAULT 'auto',        -- auto (cron) | manual (button)
  scope              text NOT NULL DEFAULT 'default',      -- default | 8w | full
  covered_from       date,
  covered_to         date,
  blocks_adjudicated integer NOT NULL DEFAULT 0,
  inserted_count     integer NOT NULL DEFAULT 0,
  sources_health     jsonb
);

CREATE INDEX IF NOT EXISTS diary_check_runs_ran_at_idx ON public.diary_check_runs (ran_at DESC);

COMMENT ON TABLE public.diary_check_runs IS
  'One row per diary-drift run (06:00 cron = auto, Scheduling-tab button = manual). Panel reads the latest for its readout block.';
