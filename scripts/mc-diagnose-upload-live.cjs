/**
 * Live busy diagnose for Upload (no writes).
 * node scripts/mc-diagnose-upload-live.cjs
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { sb } = require('../api/mc/_lib');
const { runHabitPlacerPropose } = require('../api/mc/habit-placer-propose-lib');
const { fetchHorizonEvents } = require('../api/mc/gcal-lib');
const { bankHolidaySet, holidaySetFromRows } = require('../api/mc/scheduling-rules-lib');
const { insertPrimaryEvent } = require('../api/mc/gcal-write-lib');

const ANCHOR = '2026-07-30';
const UPLOAD_ID = 'e6d11356-6276-48af-a5d3-58874c31ce5d';

(async () => {
  const from = '2026-08-20';
  const to = '2026-09-20';
  const rules = await sb('scheduling_rules?select=key,value');
  const ruleMap = Object.fromEntries((rules || []).map((r) => [r.key, r.value]));
  let holidays = bankHolidaySet(2025, 2028);
  try {
    const bh = await sb(`bank_holidays?date=gte.${from}&date=lte.${to}&select=date`);
    const set = holidaySetFromRows(bh || []);
    if (set.size) holidays = set;
  } catch (_) { /* */ }

  const { events, assessment } = await fetchHorizonEvents(`${from}T00:00:00Z`, `${to}T23:59:59Z`);
  console.log('assessment', assessment);
  console.log('event_count', (events || []).length);

  const inserted = [];
  const result = await runHabitPlacerPropose({
    sb, ruleMap, holidays, fromYmd: from, toYmd: to, gcalEvents: events,
    existingPending: async () => null, inserted, writePending: false, phaseAnchorYmd: ANCHOR,
  });

  console.log('unplaced', result.unplaced);
  console.log('placements_upload_bau', (result.placements || []).filter((p) =>
    p.habit_id === UPLOAD_ID || /BAU|Upload sites/i.test(p.title)));
  console.log('counts', result.amendment_counts);
  const amends = result.amendments || [];
  console.log('upload_amends', amends.filter((a) => /Upload sites/i.test(a.summary || a.title || '')
    || a.habit_id === UPLOAD_ID));

  // If propose has a placement for Upload, force-create on GCal + pin log
  const want = (result.placements || []).find((p) => p.habit_id === UPLOAD_ID);
  if (!want) {
    console.log('NO live placement — not forcing create');
    return;
  }
  console.log('forcing create from placement', want);
  const ev = await insertPrimaryEvent({
    summary: `MC 🔁 ${want.title}`,
    startIso: want.startIso,
    endIso: want.endIso,
    description: `habit:${UPLOAD_ID}|ideal:${want.ideal_date}|forced_by:cursor`,
  });
  console.log('created', ev.id, ev.start, ev.end);
  await sb('recurring_log', {
    method: 'POST',
    prefer: 'return=representation',
    body: {
      recurring_task_id: UPLOAD_ID,
      at: new Date().toISOString(),
      actor: 'cursor',
      change: `diary_pin:${want.startIso}|${want.endIso}|forced`,
      ideal_date: want.ideal_date,
      scheduled_date: want.day,
      calendar_event_id: ev.id,
      projection_key: `${UPLOAD_ID}|${want.ideal_date}`,
    },
  });
  console.log('pinned');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
