/**
 * Diagnose Upload placer for Aug window (dry writePending=false via direct propose).
 * node scripts/mc-diagnose-upload.cjs
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { sb } = require('../api/mc/_lib');
const { idealsInHorizon } = require('../api/mc/rrule-core');
const { runHabitPlacerPropose } = require('../api/mc/habit-placer-propose-lib');
const { fetchHorizonEvents, gcalConfigured, getAccessToken } = require('../api/mc/gcal-lib');
const { holidaySetFromRows, bankHolidaySet } = require('../api/mc/scheduling-rules-lib');
const { placeHabits } = require('../api/mc/habit-placer-lib');

const ANCHOR = '2026-07-30';
const UPLOAD_ID = 'e6d11356-6276-48af-a5d3-58874c31ce5d';

(async () => {
  const habit = (await sb(`recurring_tasks?id=eq.${UPLOAD_ID}&select=*`))[0];
  const ideals = idealsInHorizon(habit.rrule, ANCHOR, '2027-02-15', 200, ANCHOR);
  console.log('ideals', ideals);

  const from = '2026-08-20';
  const to = '2026-09-05';
  const rules = await sb('scheduling_rules?select=key,value');
  const ruleMap = Object.fromEntries((rules || []).map((r) => [r.key, r.value]));
  let holidays = bankHolidaySet(2025, 2027);
  try {
    const bh = await sb(`bank_holidays?date=gte.${from}&date=lte.${to}&select=date`);
    const set = holidaySetFromRows(bh || []);
    if (set.size) holidays = set;
  } catch (_) { /* */ }

  const { events, assessment } = await fetchHorizonEvents(`${from}T00:00:00Z`, `${to}T23:59:59Z`);
  console.log('gcal_assessment', assessment);

  // Direct placeHabits for Upload only
  const deps = await sb('recurring_task_deps?select=*');
  const { placements, unplaced } = placeHabits(
    [habit], deps || [], [], ruleMap, holidays, from, to,
    { softTaskIntervals: [], existingHabitIntervals: [], phaseAnchorYmd: ANCHOR },
  );
  console.log('place_only', { placements, unplaced });

  // With real busy from propose (read-only)
  const inserted = [];
  const result = await runHabitPlacerPropose({
    sb,
    ruleMap,
    holidays,
    fromYmd: from,
    toYmd: to,
    gcalEvents: events,
    existingPending: async () => null,
    inserted,
    writePending: false,
    phaseAnchorYmd: ANCHOR,
  });
  console.log('propose_unplaced', (result.unplaced || []).filter((u) =>
    u.habit_id === UPLOAD_ID || /Upload sites/i.test(u.title || u.habit_title || '')));
  console.log('propose_placements', (result.placements || []).filter((p) =>
    p.habit_id === UPLOAD_ID || /Upload sites/i.test(p.title || '')));
  const amends = result.amendments || result.writes || [];
  console.log('amend_upload', (Array.isArray(amends) ? amends : []).filter((a) =>
    a.habit_id === UPLOAD_ID || /Upload sites/i.test(a.summary || '')));
  console.log('counts', result.amendment_counts, 'proof', result.proof);

  const token = await getAccessToken();
  const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime`
    + `&timeMin=${encodeURIComponent('2026-08-01T00:00:00Z')}`
    + `&timeMax=${encodeURIComponent('2027-03-01T00:00:00Z')}`
    + `&q=${encodeURIComponent('Upload sites')}&maxResults=50`;
  const j = await fetch(url, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());
  console.log('gcal_upload', (j.items || []).map((e) => ({
    id: e.id,
    status: e.status,
    start: e.start?.dateTime || e.start?.date,
    end: e.end?.dateTime || e.end?.date,
    summary: (e.summary || '').slice(0, 60),
  })));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
