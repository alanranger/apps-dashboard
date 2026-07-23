/**
 * RETIRED (MC-43 Part 0) — was built for habits using tasks.recurrence (wrong source).
 * BAU habits: GET /api/mc/habit-projection.json (recurring_tasks table).
 * Recurring tasks MC-7/11/26: Claude reads tasks.recurrence from bootstrap directly.
 */
const { json, cors } = require('./_lib');

module.exports = async function handler(req, res) {
  if (cors(req, res)) return;
  return json(res, 410, {
    retired: true,
    reason: 'Use /api/mc/habit-projection.json for BAU habits (recurring_tasks). tasks.recurrence remains for MC recurring tasks.',
    replacement: '/api/mc/habit-projection.json',
    calendar_writes: 0,
  });
};
