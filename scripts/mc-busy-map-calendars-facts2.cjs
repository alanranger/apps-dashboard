/** Find Jo Galloway event on fetched calendars 12 Aug. */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { fetchHorizonEvents, getAccessToken, calendarIds } = require('../api/mc/gcal-lib');
const { buildBusyIntervals } = require('../api/mc/habit-placer-lib');
const { ruleMapFromRows } = require('../api/mc/scheduling-rules-lib');
const { sb } = require('../api/mc/_lib');

async function listCalList() {
  const token = await getAccessToken();
  const res = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  return (data.items || []).map((c) => ({
    id: c.id,
    summary: c.summary,
    primary: !!c.primary,
    accessRole: c.accessRole,
    selected: c.selected,
  }));
}

async function main() {
  const list = await listCalList();
  console.log('calendarList_count', list.length);
  console.log(JSON.stringify(list, null, 2));

  const configured = new Set(calendarIds());
  const notConfigured = list.filter((c) => !configured.has(c.id) && c.id !== 'primary');
  // primary id is email usually
  const primaryRow = list.find((c) => c.primary);
  console.log('primary_real_id', primaryRow?.id);
  console.log('configured_ids', [...configured]);
  console.log('in_account_not_in_busy_fetch', notConfigured.map((c) => ({ id: c.id, summary: c.summary })));

  const { events } = await fetchHorizonEvents(
    '2026-08-12T00:00:00.000Z',
    '2026-08-13T00:00:00.000Z',
  );
  const hits = (events || []).filter((e) =>
    /galloway|1-2-1|tuition|jo /i.test(`${e.summary || ''} ${e.description || ''}`));
  console.log('hits_in_configured_fetch', hits.map((e) => ({
    summary: e.summary,
    cal: e._calendarId,
    transparency: e.transparency || 'opaque?',
    start: e.start,
    end: e.end,
  })));

  // Direct fetch Lessons + search name match from Claude's ID
  const token = await getAccessToken();
  for (const id of [
    'nht93uaqhhd191kc3fg1kjs57k6bunhn@import.calendar.google.com',
    primaryRow?.id,
  ].filter(Boolean)) {
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(id)}/events?`
      + `timeMin=2026-08-12T00:00:00.000Z&timeMax=2026-08-13T00:00:00.000Z&singleEvents=true&maxResults=2500`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    const items = data.items || [];
    console.log('direct', id.slice(0, 40), 'status', res.status, 'count', items.length,
      'sample', items.slice(0, 5).map((e) => e.summary));
  }

  const ruleMap = ruleMapFromRows(await sb('scheduling_rules?select=key,value'));
  const busy = buildBusyIntervals(events || [], ruleMap);
  console.log('busy_summaries', busy.map((b) => b.summary));
}
main().catch((e) => { console.error(e); process.exit(1); });
