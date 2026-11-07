/**
 * Rehome diary pins that sit on hard personal busy; re-link calendar_event_ids;
 * drop dead extra ideals same day when a livelier pin exists.
 */
const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '..', '.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const { sb } = require('../api/mc/_lib.js');
const { fetchHorizonEvents } = require('../api/mc/gcal-lib.js');
const { buildBusyIntervals, trySlotOnDay, placeHabits } = require('../api/mc/habit-placer-lib.js');
const {
  ruleMapFromRows, isoToLondonDate, bankHolidaySet, addDays, londonToday,
} = require('../api/mc/scheduling-rules-lib.js');
const { relatedIdForHabit, upsertPushRow } = require('../api/mc/gcal-push-lib.js');
const { rehomePinsOverHardBusy, runHabitPlacerPropose } = require('../api/mc/habit-placer-propose-lib.js');
const { applyFlushPlan, buildFlushPlan } = require('../api/mc/gcal-flush-lib.js');

const FROM = '2026-08-10';
const TO = '2026-08-16';

function parsePin(change) {
  const m = String(change || '').match(/^diary_pin:([^|]+)\|([^|]+)/);
  if (!m) return null;
  return { start: m[1].trim(), end: m[2].trim() };
}

(async () => {
  // 1) Drop ghost second-ideal pins same day when both unfinished (keep latest at)
  const logs = await sb(
    'recurring_log?select=id,recurring_task_id,ideal_date,scheduled_date,calendar_event_id,change,at'
    + `&scheduled_date=gte.${FROM}&scheduled_date=lte.${TO}&order=at.desc&limit=2000`,
  );
  const byHabitDay = new Map();
  for (const l of logs || []) {
    if (!String(l.change || '').startsWith('diary_pin:')) continue;
    const k = `${l.recurring_task_id}|${l.scheduled_date}`;
    if (!byHabitDay.has(k)) byHabitDay.set(k, []);
    byHabitDay.get(k).push(l);
  }
  for (const list of byHabitDay.values()) {
    if (list.length < 2) continue;
    // keep first (latest at), skip rest
    for (const extra of list.slice(1)) {
      await sb(`recurring_log?id=eq.${extra.id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: {
          change: `skipped ${extra.ideal_date} (auto_dedupe twin pin)`,
          calendar_event_id: null,
        },
      });
      console.log('skipped twin ideal', extra.ideal_date, extra.id);
    }
  }

  // 2) Placer rehome + orphan retire
  const proposer = await runHabitPlacerPropose({
    mode: 'write',
    actor: 'cursor',
    proof_only: false,
  });
  console.log('placer', {
    rehomed: proposer?.habit_rolls?.rehomed,
    orphans: proposer?.habit_rolls?.orphans_retired,
    incomplete: proposer?.habit_rolls?.incomplete_rolls,
    error: proposer?.error || proposer?.habit_rolls?.rehome_error,
  });

  // 3) Flush GCal queue
  const plan = await buildFlushPlan(sb);
  console.log('flush writes', plan.write_count ?? (plan.writes || []).length);
  const result = await applyFlushPlan(sb, plan, 'cursor');
  console.log('flush applied', result.applied, 'failed', result.failed);

  // 4) Final clash probe
  const rules = ruleMapFromRows(await sb('scheduling_rules?select=key,value'));
  const { events } = await fetchHorizonEvents(`${FROM}T00:00:00Z`, `${TO}T23:59:59Z`);
  const busy = buildBusyIntervals(events || [], rules).filter((b) => !b.is_mc_recurring_gcal);
  const mc = (events || []).filter(
    (e) => (e._calendarId || 'primary') === 'primary' && e.start?.dateTime
      && /^MC\s*🔁/u.test(String(e.summary || '')),
  );
  for (const e of mc) {
    const s = Date.parse(e.start.dateTime);
    const en = Date.parse(e.end?.dateTime || e.start.dateTime);
    const hit = busy.find((b) => s < b.endMs && b.startMs < en);
    if (hit) console.log('STILL ON BUSY', e.summary, isoToLondonDate(e.start.dateTime), 'vs', hit.summary);
  }
  console.log('MC remaining:', mc.length);
  for (const e of mc.sort((a, b) => Date.parse(a.start.dateTime) - Date.parse(b.start.dateTime))) {
    console.log(isoToLondonDate(e.start.dateTime), String(e.start.dateTime).slice(11, 16), e.summary);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
