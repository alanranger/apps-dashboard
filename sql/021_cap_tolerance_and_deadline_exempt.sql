-- Alan rulings 25 Jul 2026:
-- 1. MC ⏰ deadline reminders are exempt from the 240-min task cap (and window overrun).
-- 2. Cap stays 240 with a 30-min TOLERANCE — over target (240–270) is visible but not a breach;
--    only above 270 is a hard breach. Placer must not fill to 270 by default.

INSERT INTO public.scheduling_rules (key, value, value_type, description) VALUES
  ('daily_task_cap_tolerance_min', '30', 'int',
   'Minutes over daily_task_cap_min that are "over target" (low urgency) rather than a hard breach. Hard limit = cap + tolerance.'),
  ('deadline_reminder_window_exempt', 'true', 'bool',
   'When true, MC ⏰ deadline/release reminders are excluded from the task-minute cap and working-window overrun checks.')
ON CONFLICT (key) DO UPDATE SET
  value = EXCLUDED.value,
  value_type = EXCLUDED.value_type,
  description = EXCLUDED.description,
  updated_at = now();
