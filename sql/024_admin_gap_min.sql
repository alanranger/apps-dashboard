-- Tiered breathing-space gap for MC habits (admin vs substantial).
-- admin_gap_min: after quick admin ticks; decompress_after_task_min remains for substantial.
INSERT INTO scheduling_rules (key, value, value_type, description)
VALUES (
  'admin_gap_min',
  '15',
  'number',
  'Breathing space (minutes) after a quick admin MC habit. Substantial tasks use decompress_after_task_min (incl. Publish Blog Post either side).'
)
ON CONFLICT (key) DO UPDATE
SET value = EXCLUDED.value,
    description = EXCLUDED.description;
