/**
 * Fix Dec 30 hotel ideals after Dec 16 dedupe wiped the force-placed clones.
 * Place on first free day after Christmas week (not on an existing hotel-check day).
 * node scripts/mc-fix-dec30-hotels.cjs --apply
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
const { insertPrimaryEvent, verifyPrimaryEvent } = require('../api/mc/gcal-write-lib');
const { habitGcalTitle } = require('../api/mc/gcal-title-lib');
const {
  awaySpansFromTravelBlocks, restDaySpansFromDbRows, restDaySpansFromWorkshopEvents,
  teachingDaySpansFromEvents, buildBusyIntervals, trySlotOnDay, dayBlockedForHabits,
} = require('../api/mc/habit-placer-lib');
const { ruleMapFromRows, bankHolidaySet, addDays, isoToLondonDate } = require('../api/mc/scheduling-rules-lib');

const IDS = {
  claude: '4dd47c23-92a2-4d03-8474-4f557775e3a9',
  alan: 'fc32dffb-6b5d-434b-86b9-d484ce434127',
};

(async () => {
  const rules = await sb('scheduling_rules?select=key,value');
  const ruleMap = ruleMapFromRows(rules || []);
  const holidays = bankHolidaySet(ruleMap);
  const { events } = await fetchHorizonEvents('2026-12-15T00:00:00.000Z', '2027-01-15T00:00:00.000Z');
  const travel = await sb('travel_blocks?select=*&block_type=in.(travel_out,travel_back)&starts_at=gte.2026-12-01T00:00:00Z&starts_at=lte.2027-01-15T23:59:59Z');
  const restDb = await sb('rest_day_blocks?status=eq.active&rest_date=gte.2026-12-01&rest_date=lte.2027-01-15&select=rest_date,workshop_title');
  const blocked = awaySpansFromTravelBlocks(travel || [])
    .concat(teachingDaySpansFromEvents(events || [], ruleMap))
    .concat(restDaySpansFromWorkshopEvents(events || [], ruleMap))
    .concat(restDaySpansFromDbRows(restDb || []));
  const busy = buildBusyIntervals(events || [], ruleMap).concat(blocked);
  for (const e of events || []) {
    if ((e._calendarId || 'primary') !== 'primary' || !e.start?.dateTime) continue;
    if (!/^MC\s*🔁/i.test(e.summary || '')) continue;
    busy.push({
      startMs: Date.parse(e.start.dateTime),
      endMs: Date.parse(e.end?.dateTime || e.start.dateTime),
      summary: e.summary,
    });
  }

  for (const [label, hid] of Object.entries(IDS)) {
    const habit = (await sb(`recurring_tasks?id=eq.${hid}&select=*`))[0];
    const logs = await sb(
      `recurring_log?recurring_task_id=eq.${hid}&ideal_date=eq.2026-12-30`
      + '&select=id,scheduled_date,calendar_event_id,change&order=at.desc&limit=1',
    );
    const row = logs?.[0];
    let live = false;
    if (row?.calendar_event_id) {
      try {
        live = !!(await verifyPrimaryEvent(row.calendar_event_id));
      } catch (_) { live = false; }
    }
    console.log(label, 'log', row?.scheduled_date, row?.calendar_event_id, 'live', live);
    if (live) continue;

    // Prefer 28–29 Dec or 2–5 Jan (avoid 16 Dec which already has hotel checks)
    const prefer = ['2026-12-28', '2026-12-29', '2027-01-02', '2027-01-05', '2027-01-06', '2027-01-07'];
    let slot = null;
    const dayUsed = {};
    for (const day of prefer) {
      if (dayBlockedForHabits(day, blocked)) continue;
      const trial = trySlotOnDay(
        day, Number(habit.duration_min) || 45, habit.ideal_time || '10:00',
        habit.title, busy, [], dayUsed, ruleMap,
      );
      if (trial) { slot = trial; break; }
    }
    if (!slot) {
      console.log(label, 'NO SLOT');
      continue;
    }
    console.log(label, '->', slot.day, slot.startIso);
    if (!APPLY) continue;
    const title = habitGcalTitle(habit.title, { habit: ruleMap.title_prefix_recurring || 'MC 🔁' });
    const evt = await insertPrimaryEvent({
      summary: title,
      description: `Mission Control habit — ${habit.title}`,
      startIso: slot.startIso,
      endIso: slot.endIso,
    });
    const body = {
      scheduled_date: slot.day,
      calendar_event_id: evt.id,
      change: `diary_pin:${slot.startIso}|${slot.endIso}`,
    };
    if (row?.id) {
      await sb(`recurring_log?id=eq.${row.id}`, { method: 'PATCH', prefer: 'return=minimal', body });
    } else {
      await sb('recurring_log', {
        method: 'POST', prefer: 'return=minimal',
        body: { recurring_task_id: hid, ideal_date: '2026-12-30', actor: 'cursor', ...body },
      });
    }
    busy.push({
      startMs: Date.parse(slot.startIso),
      endMs: Date.parse(slot.endIso),
      summary: habit.title,
    });
    console.log(label, 'created', evt.id);
  }
})().catch((e) => { console.error(e); process.exit(1); });
