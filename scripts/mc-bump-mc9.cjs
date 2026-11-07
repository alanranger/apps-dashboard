/**
 * Move soft task MC-9 off Upload sites clash on 29 Jul.
 * node scripts/mc-bump-mc9.cjs --apply
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const APPLY = process.argv.includes('--apply');
const { sb } = require('../api/mc/_lib');
const { fetchHorizonEvents } = require('../api/mc/gcal-lib');
const { patchPrimaryEvent } = require('../api/mc/gcal-write-lib');
const {
  trySlotOnDay, buildBusyIntervals, awaySpansFromTravelBlocks,
  teachingDaySpansFromEvents, restDaySpansFromWorkshopEvents, restDaySpansFromDbRows,
  dayBlockedForHabits,
} = require('../api/mc/habit-placer-lib');
const { ruleMapFromRows, addDays, isoToLondonDate } = require('../api/mc/scheduling-rules-lib');

(async () => {
  const task = (await sb('tasks?display_id=eq.9&select=*'))[0];
  console.log('task', task?.title, task?.scheduled_start, task?.calendar_event_id, task?.slot_pinned);
  if (!task || task.slot_pinned) {
    console.log('skip pinned/missing');
    return;
  }
  const { events } = await fetchHorizonEvents('2026-07-28T00:00:00.000Z', '2026-08-20T00:00:00.000Z');
  const rules = await sb('scheduling_rules?select=key,value');
  const ruleMap = ruleMapFromRows(rules || []);
  const travel = await sb('travel_blocks?select=*&block_type=in.(travel_out,travel_back)&starts_at=gte.2026-07-28T00:00:00Z&starts_at=lte.2026-08-20T23:59:59Z');
  const restDb = await sb('rest_day_blocks?status=eq.active&rest_date=gte.2026-07-28&rest_date=lte.2026-08-20&select=rest_date,workshop_title');
  const blocked = awaySpansFromTravelBlocks(travel || [])
    .concat(teachingDaySpansFromEvents(events || [], ruleMap))
    .concat(restDaySpansFromWorkshopEvents(events || [], ruleMap))
    .concat(restDaySpansFromDbRows(restDb || []));
  const busy = buildBusyIntervals(events || [], ruleMap).concat(blocked);
  for (const e of events || []) {
    if ((e._calendarId || 'primary') !== 'primary' || !e.start?.dateTime) continue;
    if (e.id === task.calendar_event_id) continue;
    if (!/^MC\s/i.test(e.summary || '') && !/^P\d\s*·\s*MC-/i.test(e.summary || '')) continue;
    busy.push({
      startMs: Date.parse(e.start.dateTime),
      endMs: Date.parse(e.end?.dateTime || e.start.dateTime),
      summary: e.summary,
    });
  }
  const dur = Math.max(15, Math.round((Date.parse(task.scheduled_end) - Date.parse(task.scheduled_start)) / 60000));
  let slot = null;
  for (let i = 0; i < 14; i += 1) {
    const day = addDays('2026-07-29', i === 0 ? 1 : i); // prefer after clash day
    if (dayBlockedForHabits(day, blocked)) continue;
    const trial = trySlotOnDay(day, dur, '10:00', task.title, busy, [], {}, ruleMap);
    if (trial) { slot = trial; break; }
  }
  console.log('slot', slot);
  if (!slot || !APPLY) return;
  if (task.calendar_event_id) {
    await patchPrimaryEvent(task.calendar_event_id, { startIso: slot.startIso, endIso: slot.endIso });
  }
  await sb(`tasks?display_id=eq.9`, {
    method: 'PATCH', prefer: 'return=minimal',
    body: { scheduled_start: slot.startIso, scheduled_end: slot.endIso },
  });
  console.log('bumped MC-9 to', slot.day, slot.startIso);
})().catch((e) => { console.error(e); process.exit(1); });
