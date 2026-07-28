const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { sb } = require('../api/mc/_lib');
const { fetchHorizonEvents } = require('../api/mc/gcal-lib');
const {
  ruleMapFromRows, isoToLondonDate, isoToLondonMinutes, workingWindow,
} = require('../api/mc/scheduling-rules-lib');
const {
  awaySpansFromTravelBlocks, teachingDaySpansFromEvents,
  restDaySpansFromWorkshopEvents, dayBlockedForHabits, londonYmdHmToUtcMs,
} = require('../api/mc/habit-placer-lib');
const { patchPrimaryEvent } = require('../api/mc/gcal-write-lib');

(async () => {
  const [rules, travel, gcal] = await Promise.all([
    sb('scheduling_rules?select=key,value'),
    sb('travel_blocks?select=*&order=starts_at.asc'),
    fetchHorizonEvents('2026-07-28T00:00:00.000Z', '2027-02-01T00:00:00.000Z'),
  ]);
  const ruleMap = ruleMapFromRows(rules || []);
  const spans = awaySpansFromTravelBlocks(travel || [])
    .concat(teachingDaySpansFromEvents(gcal.events || [], ruleMap))
    .concat(restDaySpansFromWorkshopEvents(gcal.events || [], ruleMap));

  console.log('--- deadline BAD? ---');
  for (const e of gcal.events || []) {
    if (!/MC\s*⏰/i.test(e.summary || '') || !/Hotel|Room release|cancel/i.test(e.summary || '')) continue;
    const day = isoToLondonDate(e.start.dateTime);
    const mins = isoToLondonMinutes(e.start.dateTime);
    const win = workingWindow(ruleMap, day);
    const after = mins < (win?.start_min ?? 540) || mins > (win?.end_min ?? 1080);
    const blocked = dayBlockedForHabits(day, spans);
    if (blocked || after) console.log('BAD', day, blocked ? 'BLOCKED' : '', after ? 'AFTER' : '', e.summary.slice(0, 60));
  }

  console.log('--- MC-8 / MC-12 ---');
  for (const e of gcal.events || []) {
    if (/MC-8\b|MC-12\b|Rev-weight|competitor sign-off|Page-3/i.test(e.summary || '')) {
      console.log(e.id, e.start?.dateTime, e.summary);
    }
  }

  for (const e of gcal.events || []) {
    if (!/MC\s*⏰/i.test(e.summary || '') || !/Angel Inn Wangford/i.test(e.summary || '')) continue;
    const day = isoToLondonDate(e.start.dateTime);
    const win = workingWindow(ruleMap, day);
    const startMin = win?.start_min ?? 9 * 60;
    const pad = (n) => String(n).padStart(2, '0');
    const hm = `${pad(Math.floor(startMin / 60))}:${pad(startMin % 60)}`;
    const endMin = startMin + 20;
    const hm2 = `${pad(Math.floor(endMin / 60))}:${pad(endMin % 60)}`;
    const startIso = new Date(londonYmdHmToUtcMs(day, hm)).toISOString();
    const endIso = new Date(londonYmdHmToUtcMs(day, hm2)).toISOString();
    await patchPrimaryEvent(e.id, { startIso, endIso });
    console.log('angel in-window', day, startIso);
  }
})().catch((e) => { console.error(e); process.exit(1); });
