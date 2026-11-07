import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
for (const line of fs.readFileSync(path.join(root, '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { sb } = require('../api/mc/_lib.js');
const { ruleMapFromRows, bankHolidaySet } = require('../api/mc/scheduling-rules-lib.js');
const {
  awaySpansFromTravelBlocks, restDaySpansFromWorkshopEvents, teachingDaySpansFromEvents,
  candidateDays, dayBlockedForPlacement, coveringBlockedSpan, buildBusyIntervals,
  datedTasksToIntervals, trySlotOnDay,
} = require('../api/mc/habit-placer-lib.js');
const { fetchHorizonEvents } = require('../api/mc/gcal-lib.js');

const cases = [
  ['Artfully', '2026-09-10', 'FREQ=MONTHLY;BYDAY=2TH', false, 2, 5, '09:00', 'Check Artfully Walls Sales'],
  ['BAU', '2026-09-21', 'FREQ=WEEKLY;INTERVAL=8;BYDAY=MO', false, 3, 240, '10:00', 'BAU Day 1'],
  ['L&L', '2026-11-15', 'FREQ=MONTHLY;BYMONTHDAY=15', false, 2, 240, '10:00', 'Light & Logic'],
  ['Blog', '2026-11-19', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TH', false, 2, 120, '11:00', 'Publish Blog Post'],
  ['Review', '2026-11-20', 'FREQ=WEEKLY;BYDAY=FR', false, 2, 120, '10:00', 'Review/Amend'],
];

const ruleMap = ruleMapFromRows(await sb('scheduling_rules?select=key,value'));
const holidays = bankHolidaySet(2026, 2027);
const { events } = await fetchHorizonEvents('2026-09-01T00:00:00.000Z', '2026-12-01T23:59:59.000Z');
const travel = await sb(
  'travel_blocks?select=block_type,starts_at,ends_at,venue_name,workshop_title,workshop_start,workshop_row_key'
  + '&block_type=in.(travel_out,travel_back)&starts_at=gte.2026-09-01T00:00:00Z&starts_at=lte.2026-12-01T23:59:59Z',
);
const blocked = awaySpansFromTravelBlocks(travel || [])
  .concat(restDaySpansFromWorkshopEvents(events || [], ruleMap))
  .concat(teachingDaySpansFromEvents(events || [], ruleMap));
const tasks = await sb(
  'tasks?select=display_id,title,state,slot_pinned,scheduled_start,scheduled_end'
  + '&scheduled_start=gte.2026-09-01T00:00:00Z&scheduled_start=lte.2026-12-01T23:59:59Z'
  + '&state=not.in.(done,verified,wont_do,superseded)',
);
const busy = buildBusyIntervals(events || [], ruleMap)
  .concat(datedTasksToIntervals(tasks || [], { pinnedOnly: true }))
  .concat(datedTasksToIntervals(tasks || [], { pinnedOnly: false }))
  .concat(blocked);

for (const [n, ideal, rrule, tc, w, dur, hm, title] of cases) {
  const days = candidateDays(ideal, w, tc, ruleMap, holidays, blocked, rrule);
  const cover = coveringBlockedSpan(ideal, blocked);
  console.log('\n' + n, { ideal, cover, days, blockedOnIdeal: dayBlockedForPlacement(ideal, blocked) });
  for (const day of days) {
    const trial = trySlotOnDay(day, dur, hm, title, busy, [], {}, ruleMap);
    console.log('  try', day, trial ? `${trial.startIso}` : 'FAIL');
  }
}
