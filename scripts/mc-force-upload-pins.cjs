/**
 * Force-create Upload pins after live BAU2 for each cycle.
 * node scripts/mc-force-upload-pins.cjs
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { sb } = require('../api/mc/_lib');
const { runHabitPlacerPropose } = require('../api/mc/habit-placer-propose-lib');
const { fetchHorizonEvents, getAccessToken } = require('../api/mc/gcal-lib');
const { insertPrimaryEvent, deletePrimaryEvent } = require('../api/mc/gcal-write-lib');
const { bankHolidaySet, holidaySetFromRows } = require('../api/mc/scheduling-rules-lib');
const { idealsInHorizon } = require('../api/mc/rrule-core');
const { placeHabits } = require('../api/mc/habit-placer-lib');

const ANCHOR = '2026-07-30';
const UPLOAD_ID = 'e6d11356-6276-48af-a5d3-58874c31ce5d';
const BAU2_ID = '65bb5023-40a3-4797-8e9c-e0b85f0581b6';

function addDays(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

(async () => {
  const habits = await sb('recurring_tasks?active=eq.true&select=*');
  const deps = await sb('recurring_task_deps?select=*');
  const rules = await sb('scheduling_rules?select=key,value');
  const ruleMap = Object.fromEntries((rules || []).map((r) => [r.key, r.value]));
  let holidays = bankHolidaySet(2025, 2028);
  try {
    const bh = await sb('bank_holidays?date=gte.2026-08-01&date=lte.2027-03-01&select=date');
    const set = holidaySetFromRows(bh || []);
    if (set.size) holidays = set;
  } catch (_) { /* */ }

  // Prefer live propose per cycle window; fall back to empty-busy placeHabits.
  const uploadIdeals = idealsInHorizon(
    (habits.find((h) => h.id === UPLOAD_ID) || {}).rrule,
    ANCHOR, '2027-02-28', 200, ANCHOR,
  );
  console.log('upload_ideals', uploadIdeals);

  const created = [];
  for (const ideal of uploadIdeals) {
    const from = addDays(ideal, -10);
    const to = addDays(ideal, 25);
    const { events, assessment } = await fetchHorizonEvents(`${from}T00:00:00Z`, `${to}T23:59:59Z`);
    console.log(ideal, 'assessment', assessment?.ok, 'events', (events || []).length);

    const inserted = [];
    const live = await runHabitPlacerPropose({
      sb, ruleMap, holidays, fromYmd: from, toYmd: to, gcalEvents: events,
      existingPending: async () => null, inserted, writePending: false, phaseAnchorYmd: ANCHOR,
    });
    let slot = (live.placements || []).find((p) => p.habit_id === UPLOAD_ID && p.ideal_date === ideal);
    if (!slot) {
      // Fall back: empty busy packing for this cycle only (BAU+Upload)
      const subset = (habits || []).filter((h) =>
        h.id === UPLOAD_ID || /BAU global refresh/i.test(h.title));
      const { placements } = placeHabits(
        subset, deps || [], [], ruleMap, holidays, from, to,
        { softTaskIntervals: [], existingHabitIntervals: [], phaseAnchorYmd: ANCHOR },
      );
      slot = placements.find((p) => p.habit_id === UPLOAD_ID && p.ideal_date === ideal);
      console.log(ideal, 'fallback_slot', slot && { day: slot.day, start: slot.startIso, end: slot.endIso });
    } else {
      console.log(ideal, 'live_slot', { day: slot.day, start: slot.startIso, end: slot.endIso });
    }
    if (!slot) {
      console.log(ideal, 'STILL_NO_SLOT', (live.unplaced || []).filter((u) => u.habit_id === UPLOAD_ID));
      continue;
    }

    // Delete any existing Upload events near this day
    const token = await getAccessToken();
    const q = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true`
      + `&timeMin=${encodeURIComponent(`${slot.day}T00:00:00Z`)}`
      + `&timeMax=${encodeURIComponent(`${addDays(slot.day, 1)}T23:59:59Z`)}`
      + `&q=${encodeURIComponent('Upload sites')}&maxResults=10`,
      { headers: { Authorization: `Bearer ${token}` } },
    ).then((r) => r.json());
    for (const e of q.items || []) {
      if (e.status === 'cancelled') continue;
      if (!/Upload sites/i.test(e.summary || '')) continue;
      await deletePrimaryEvent(e.id);
      console.log('deleted_old', e.id);
    }

    const ev = await insertPrimaryEvent({
      summary: `MC 🔁 ${slot.title}`,
      startIso: slot.startIso,
      endIso: slot.endIso,
      description: `habit:${UPLOAD_ID}|ideal:${ideal}|forced_by:cursor-resync`,
    });
    await sb('recurring_log', {
      method: 'POST',
      prefer: 'return=minimal',
      body: {
        recurring_task_id: UPLOAD_ID,
        at: new Date().toISOString(),
        actor: 'cursor',
        change: `diary_pin:${slot.startIso}|${slot.endIso}|forced_resync`,
        ideal_date: ideal,
        scheduled_date: slot.day,
        calendar_event_id: ev.id,
        projection_key: `${UPLOAD_ID}|${ideal}`,
      },
    });
    created.push({ ideal, day: slot.day, event_id: ev.id, start: slot.startIso, end: slot.endIso });
    console.log('created', created[created.length - 1]);
  }

  console.log('DONE', created);

  // Confirm BAU2 exists near each Upload for dep sanity
  const bau2 = await sb(
    `recurring_log?recurring_task_id=eq.${BAU2_ID}&ideal_date=gte.2026-07-30&select=ideal_date,scheduled_date,change,calendar_event_id,at&order=at.desc&limit=20`,
  );
  const bauLatest = new Map();
  for (const row of bau2 || []) {
    if (!bauLatest.has(row.ideal_date)) bauLatest.set(row.ideal_date, row);
  }
  console.log('bau2_latest', [...bauLatest.entries()].sort((a, b) => a[0].localeCompare(b[0])));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
