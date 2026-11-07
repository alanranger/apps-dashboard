/**
 * Force-place Dec Light & Logic into first free 4h slot in window.
 * node scripts/mc-place-ll-dec.cjs
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const LL_ID = 'c2f135c9-7146-415d-8231-c2460a064e94';
const { sb } = require('../api/mc/_lib');
const { fetchHorizonEvents } = require('../api/mc/gcal-lib');
const { insertPrimaryEvent } = require('../api/mc/gcal-write-lib');
const { habitGcalTitle } = require('../api/mc/gcal-title-lib');
const {
  trySlotOnDay, awaySpansFromTravelBlocks, restDaySpansFromDbRows,
  restDaySpansFromWorkshopEvents, teachingDaySpansFromEvents, buildBusyIntervals,
  dayBlockedForHabits, candidateDays,
} = require('../api/mc/habit-placer-lib');
const { ruleMapFromRows, bankHolidaySet, isoToLondonDate } = require('../api/mc/scheduling-rules-lib');

(async () => {
  const ideal = '2026-12-15';
  const rules = await sb('scheduling_rules?select=key,value');
  const ruleMap = ruleMapFromRows(rules || []);
  const holidays = bankHolidaySet(ruleMap);
  const { events } = await fetchHorizonEvents('2026-12-10T00:00:00.000Z', '2026-12-22T00:00:00.000Z');

  for (const e of (events || []).filter((x) => x.start?.dateTime)
    .sort((a, b) => a.start.dateTime.localeCompare(b.start.dateTime))) {
    console.log(
      isoToLondonDate(e.start.dateTime),
      e.start.dateTime.slice(11, 16),
      (e._calendarId || 'primary').slice(0, 12),
      String(e.summary || '').slice(0, 80),
    );
  }

  const travel = await sb('travel_blocks?select=*&block_type=in.(travel_out,travel_back)&starts_at=gte.2026-12-01T00:00:00Z&starts_at=lte.2026-12-31T23:59:59Z');
  const restDb = await sb('rest_day_blocks?status=eq.active&rest_date=gte.2026-12-01&rest_date=lte.2026-12-31&select=rest_date,workshop_title');
  const blocked = awaySpansFromTravelBlocks(travel || [])
    .concat(teachingDaySpansFromEvents(events || [], ruleMap))
    .concat(restDaySpansFromWorkshopEvents(events || [], ruleMap))
    .concat(restDaySpansFromDbRows(restDb || []));
  const busy = buildBusyIntervals(events || [], ruleMap).concat(blocked);
  for (const e of events || []) {
    if ((e._calendarId || 'primary') !== 'primary' || !e.start?.dateTime) continue;
    if (!/^MC\s/i.test(e.summary || '')) continue;
    busy.push({
      startMs: Date.parse(e.start.dateTime),
      endMs: Date.parse(e.end?.dateTime || e.start.dateTime),
      summary: e.summary,
    });
  }

  // Wider window for this stubborn month (ideal ±5)
  const days = candidateDays(ideal, 5, false, ruleMap, holidays, blocked, 'FREQ=MONTHLY;BYMONTHDAY=15', true);
  console.log('candidates', days);
  let slot = null;
  const dayUsed = {};
  for (const day of days) {
    if (dayBlockedForHabits(day, blocked)) continue;
    const trial = trySlotOnDay(day, 240, '10:00', 'Light & Logic newsletter issue', busy, [], dayUsed, ruleMap);
    console.log('try', day, trial ? `${trial.startIso}-${trial.endIso}` : 'fail');
    if (trial) { slot = trial; break; }
  }
  if (!slot) {
    console.log('NO SLOT');
    process.exit(2);
  }

  const title = habitGcalTitle('Light & Logic newsletter issue', { habit: ruleMap.title_prefix_recurring || 'MC 🔁' });
  const createdEvt = await insertPrimaryEvent({
    summary: title,
    description: 'Mission Control habit — Light & Logic newsletter (4h).',
    startIso: slot.startIso,
    endIso: slot.endIso,
  });
  const logs = await sb(`recurring_log?recurring_task_id=eq.${LL_ID}&ideal_date=eq.${ideal}&select=id`);
  const change = `diary_pin:${slot.startIso}|${slot.endIso}`;
  if (logs?.[0]?.id) {
    await sb(`recurring_log?id=eq.${logs[0].id}`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: { scheduled_date: slot.day, calendar_event_id: createdEvt.id, change },
    });
  } else {
    await sb('recurring_log', {
      method: 'POST', prefer: 'return=minimal',
      body: {
        recurring_task_id: LL_ID, ideal_date: ideal, scheduled_date: slot.day,
        calendar_event_id: createdEvt.id, change,
      },
    });
  }
  console.log('placed', slot.day, createdEvt.id);
})().catch((e) => { console.error(e); process.exit(1); });
