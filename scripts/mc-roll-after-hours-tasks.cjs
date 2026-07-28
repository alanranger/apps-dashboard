/**
 * Move MC-12 / MC-8 into first free working-window slot (same day, or walk earlier).
 * node scripts/mc-roll-after-hours-tasks.cjs
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { sb } = require('../api/mc/_lib');
const { fetchHorizonEvents } = require('../api/mc/gcal-lib');
const { patchPrimaryEvent, verifyPrimaryEvent } = require('../api/mc/gcal-write-lib');
const { ruleMapFromRows, addDays, isoToLondonDate } = require('../api/mc/scheduling-rules-lib');
const {
  awaySpansFromTravelBlocks, teachingDaySpansFromEvents,
  restDaySpansFromWorkshopEvents, dayBlockedForHabits,
} = require('../api/mc/habit-placer-lib');
const { reminderWindowIso } = require('../api/mc/hotel-deadline-place-lib');
const { londonToday, addDaysYmd } = require('../api/mc/diary-lib');

const MATCH = /P3 · MC-12 · Page-3 competitor sign-off|P1 · MC-8 · Rev-weighting brief/;

async function main() {
  const today = londonToday();
  const [rules, travel, gcal] = await Promise.all([
    sb('scheduling_rules?select=key,value'),
    sb('travel_blocks?select=*&order=starts_at.asc'),
    fetchHorizonEvents(`${addDaysYmd(today, -7)}T00:00:00.000Z`, `${addDaysYmd(today, 60)}T00:00:00.000Z`),
  ]);
  const ruleMap = ruleMapFromRows(rules || []);
  const spans = awaySpansFromTravelBlocks(travel || [])
    .concat(teachingDaySpansFromEvents(gcal.events || [], ruleMap))
    .concat(restDaySpansFromWorkshopEvents(gcal.events || [], ruleMap));

  let n = 0;
  for (const e of gcal.events || []) {
    if ((e._calendarId || 'primary') !== 'primary' || !e.start?.dateTime) continue;
    if (!MATCH.test(e.summary || '')) continue;
    let day = isoToLondonDate(e.start.dateTime);
    const others = (gcal.events || []).filter((x) => x.id !== e.id);
    let slot = null;
    for (let i = 0; i < 14; i += 1) {
      if (!dayBlockedForHabits(day, spans)) {
        slot = reminderWindowIso(day, ruleMap, 60, others);
        if (slot) break;
      }
      day = addDays(day, -1);
      if (day < today) break;
    }
    if (!slot) {
      console.log('no slot', e.summary);
      continue;
    }
    await patchPrimaryEvent(e.id, { startIso: slot.startIso, endIso: slot.endIso });
    const v = await verifyPrimaryEvent(e.id, { startIso: slot.startIso, endIso: slot.endIso });
    console.log(v.ok ? 'rolled' : 'FAIL', e.summary, '->', slot.day, slot.startIso);
    n += 1;
  }
  console.log(JSON.stringify({ rolled: n }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
