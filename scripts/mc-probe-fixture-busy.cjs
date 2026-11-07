/** Probe Ipswich event titles vs isFixtureBlock / buildBusyIntervals. */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { fetchHorizonEvents, isForceBusyCalendar } = require('../api/mc/gcal-lib');
const { isFixtureBlock, isMcBlock } = require('../api/mc/rule-breach-lib');
const { buildBusyIntervals } = require('../api/mc/habit-placer-lib');
const { ruleMapFromRows } = require('../api/mc/scheduling-rules-lib');
const { sb } = require('../api/mc/_lib');

(async () => {
  const rules = await sb('scheduling_rules?select=key,value');
  const ruleMap = ruleMapFromRows(rules || []);
  const { events } = await fetchHorizonEvents('2026-09-01T00:00:00.000Z', '2026-09-15T00:00:00.000Z');
  const ipswich = (events || []).filter((e) => isForceBusyCalendar(e._calendarId) || /ipswich|⚽/i.test(e.summary || ''));
  console.log(JSON.stringify(ipswich.map((e) => ({
    summary: e.summary,
    cal: e._calendarId,
    force: isForceBusyCalendar(e._calendarId),
    isFixtureBlock: isFixtureBlock(e, ruleMap),
    isMcBlock: isMcBlock(e),
    skipped_by_busy: isMcBlock(e) || isFixtureBlock(e, ruleMap),
    start: e.start?.dateTime,
  })), null, 2));
  const busy = buildBusyIntervals(events || [], ruleMap);
  const busyHit = busy.filter((b) => /ipswich|liverpool|palace/i.test(b.summary || ''));
  console.log('busy_fixture_hits', busyHit.length, busyHit.slice(0, 5));
})().catch((e) => { console.error(e); process.exit(1); });
