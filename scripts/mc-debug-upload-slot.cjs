/**
 * Step-debug Upload slot search for 2026-08-26.
 * node scripts/mc-debug-upload-slot.cjs
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { sb } = require('../api/mc/_lib');
const {
  placeHabits, candidateDays, isSchedulableDay, dayBlockedForHabits, trySlotOnDay,
} = require('../api/mc/habit-placer-lib');
const { bankHolidaySet, holidaySetFromRows } = require('../api/mc/scheduling-rules-lib');

const ANCHOR = '2026-07-30';
const IDEAL = '2026-08-26';
const UPLOAD_ID = 'e6d11356-6276-48af-a5d3-58874c31ce5d';

(async () => {
  const habit = (await sb(`recurring_tasks?id=eq.${UPLOAD_ID}&select=*`))[0];
  const rules = await sb('scheduling_rules?select=key,value');
  const ruleMap = Object.fromEntries((rules || []).map((r) => [r.key, r.value]));
  let holidays = bankHolidaySet(2025, 2027);
  try {
    const bh = await sb('bank_holidays?date=gte.2026-08-01&date=lte.2026-09-30&select=date');
    const set = holidaySetFromRows(bh || []);
    if (set.size) holidays = set;
  } catch (_) { /* */ }

  const awaySpans = [];
  const windowDays = candidateDays(
    IDEAL, habit.window_days, habit.time_critical === true, ruleMap, holidays, awaySpans,
    habit.rrule, true,
  );
  console.log('windowDays', windowDays);
  console.log('rule_work', {
    workday_start: ruleMap.workday_start,
    workday_end: ruleMap.workday_end,
    daily_task_cap_min: ruleMap.daily_task_cap_min,
    daily_task_cap_tolerance_min: ruleMap.daily_task_cap_tolerance_min,
  });

  const days = [];
  let d = IDEAL;
  for (let i = 0; i < 20; i += 1) {
    days.push(d);
    const dt = new Date(`${d}T12:00:00Z`);
    dt.setUTCDate(dt.getUTCDate() + 1);
    d = dt.toISOString().slice(0, 10);
  }

  for (const day of days) {
    const sched = isSchedulableDay(day, ruleMap, holidays);
    const blocked = dayBlockedForHabits(day, awaySpans);
    let trial = null;
    let err = null;
    try {
      trial = trySlotOnDay(
        day, Number(habit.duration_min) || 60, habit.ideal_time || '09:00',
        habit.title, [], [], {}, ruleMap, { ignoreCap: true },
      );
    } catch (e) {
      err = String(e.message || e);
    }
    console.log(day, { sched, blocked, trial: trial && { day: trial.day, startIso: trial.startIso, endIso: trial.endIso }, err });
  }

  // Wider horizon placement
  const { placements, unplaced } = placeHabits(
    [habit], [], [], ruleMap, holidays, '2026-08-01', '2026-12-31',
    { softTaskIntervals: [], existingHabitIntervals: [], phaseAnchorYmd: ANCHOR },
  );
  console.log('wide', { placements, unplaced });
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
