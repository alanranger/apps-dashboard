/** Read-only: which calendars load + is Jo Galloway in busy map for 12 Aug. */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const {
  calendarIds, EXPECTED_CALENDARS, fetchHorizonEvents, FORCE_BUSY_CALENDAR_IDS,
} = require('../api/mc/gcal-lib');
const { buildBusyIntervals, isTeachingCalendarEvent } = require('../api/mc/habit-placer-lib');
const { ruleMapFromRows } = require('../api/mc/scheduling-rules-lib');
const { sb } = require('../api/mc/_lib');

async function main() {
  const ids = calendarIds();
  const envOverride = !!process.env.GCAL_CALENDAR_IDS;
  console.log(JSON.stringify({
    env_GCAL_CALENDAR_IDS_set: envOverride,
    calendarIds_runtime: ids,
    EXPECTED_CALENDARS,
    FORCE_BUSY: [...FORCE_BUSY_CALENDAR_IDS],
  }, null, 2));

  const rules = await sb('scheduling_rules?select=key,value&key=eq.busy_map_scope');
  console.log('busy_map_scope_db', rules);

  const { events, health, assessment } = await fetchHorizonEvents(
    '2026-08-12T00:00:00.000Z',
    '2026-08-13T00:00:00.000Z',
  );
  console.log('health', health, 'assessment', assessment);

  const jo = (events || []).filter((e) => /galloway|jo /i.test(e.summary || ''));
  console.log('jo_events', jo.map((e) => ({
    summary: e.summary,
    _calendarId: e._calendarId,
    transparency: e.transparency || null,
    start: e.start,
    end: e.end,
    isTeaching: isTeachingCalendarEvent(e),
  })));

  const ruleMap = ruleMapFromRows(await sb('scheduling_rules?select=key,value'));
  const busy = buildBusyIntervals(events || [], ruleMap);
  const joBusy = busy.filter((b) => /galloway|jo /i.test(b.summary || ''));
  console.log('jo_in_buildBusyIntervals', joBusy);
  console.log('busy_count_12aug_window', busy.length);
}
main().catch((e) => { console.error(e); process.exit(1); });
