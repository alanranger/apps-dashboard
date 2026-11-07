/**
 * Three-way verify: expected ideals ↔ recurring_log ↔ Google Calendar.
 * node scripts/mc-three-way-verify.cjs
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { sb } = require('../api/mc/_lib');
const { idealsInHorizon } = require('../api/mc/rrule-core');
const { getAccessToken } = require('../api/mc/gcal-lib');

const ANCHOR = '2026-07-30';
const FROM = '2026-07-30';
const TO = '2027-02-28';

const TRACK = [
  { match: /BAU global refresh — Day 1/i, label: 'BAU1' },
  { match: /BAU global refresh — Day 2/i, label: 'BAU2' },
  { match: /^Upload sites/i, label: 'Upload' },
  { match: /Backup/i, label: 'Backup' },
  { match: /Update Event Schema/i, label: 'EventSchema' },
];

function minsBetween(a, b) {
  return Math.round((Date.parse(b) - Date.parse(a)) / 60000);
}

function latestByIdeal(rows) {
  const map = new Map();
  for (const r of rows || []) {
    if (!r.ideal_date) continue;
    if (!map.has(r.ideal_date)) map.set(r.ideal_date, r);
  }
  return map;
}

async function getEvent(token, id) {
  if (!id) return null;
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(id)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const j = await res.json();
  return { http: res.status, ...j };
}

async function searchTitle(token, q) {
  const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime`
    + `&timeMin=${encodeURIComponent(`${FROM}T00:00:00Z`)}`
    + `&timeMax=${encodeURIComponent(`${TO}T23:59:59Z`)}`
    + `&q=${encodeURIComponent(q)}&maxResults=50`;
  const j = await fetch(url, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());
  return (j.items || []).filter((e) => e.status !== 'cancelled');
}

(async () => {
  const token = await getAccessToken();
  const habits = await sb('recurring_tasks?active=eq.true&select=id,title,rrule,duration_min');
  const report = { ok: [], warn: [], fail: [] };

  const pending = await sb('gcal_push_queue?status=eq.pending&select=id,summary&limit=20');
  if ((pending || []).length) {
    report.fail.push({ kind: 'push_queue_pending', n: pending.length, sample: pending.slice(0, 5) });
  } else {
    report.ok.push({ kind: 'push_queue_empty' });
  }

  for (const t of TRACK) {
    const habit = (habits || []).find((h) => t.match.test(h.title));
    if (!habit) {
      report.fail.push({ kind: 'habit_missing', label: t.label });
      continue;
    }
    const ideals = idealsInHorizon(habit.rrule, FROM, TO, 200, ANCHOR);
    const logs = await sb(
      `recurring_log?recurring_task_id=eq.${habit.id}&ideal_date=gte.${FROM}&ideal_date=lte.${TO}`
      + `&select=ideal_date,scheduled_date,change,calendar_event_id,at&order=at.desc&limit=80`,
    );
    const latest = latestByIdeal(logs);
    const gcalHits = await searchTitle(token, habit.title.slice(0, 28));

    console.log(`\n=== ${t.label}: ${habit.title} ===`);
    console.log('ideals', ideals);
    console.log('gcal_confirmed_count', gcalHits.length, gcalHits.map((e) => e.start?.dateTime || e.start?.date));

    for (const ideal of ideals) {
      const row = latest.get(ideal);
      const pinned = row && /diary_pin/i.test(row.change || '') && row.calendar_event_id;
      const unplaced = row && /unplaced|retired|cleared stale/i.test(row.change || '');
      let ev = null;
      if (pinned) ev = await getEvent(token, row.calendar_event_id);

      const item = {
        label: t.label,
        ideal,
        db_change: row?.change || null,
        db_scheduled: row?.scheduled_date || null,
        event_id: row?.calendar_event_id || null,
        gcal_status: ev?.status || (pinned ? `http_${ev?.http}` : null),
        gcal_start: ev?.start?.dateTime || null,
        gcal_end: ev?.end?.dateTime || null,
        gcal_mins: ev?.start?.dateTime && ev?.end?.dateTime
          ? minsBetween(ev.start.dateTime, ev.end.dateTime) : null,
        expect_mins: habit.duration_min,
      };

      if (!row) {
        report.fail.push({ ...item, reason: 'no_db_log_for_ideal' });
        continue;
      }
      if (unplaced && !pinned) {
        // Upload may be pinned under later nudge log — check any diary_pin for ideal
        const anyPin = (logs || []).find((r) => r.ideal_date === ideal && /diary_pin/i.test(r.change || '') && r.calendar_event_id);
        if (!anyPin) {
          report.fail.push({ ...item, reason: 'ideal_unplaced_no_pin' });
          continue;
        }
        ev = await getEvent(token, anyPin.calendar_event_id);
        item.event_id = anyPin.calendar_event_id;
        item.db_change = anyPin.change;
        item.db_scheduled = anyPin.scheduled_date;
        item.gcal_status = ev?.status;
        item.gcal_start = ev?.start?.dateTime || null;
        item.gcal_end = ev?.end?.dateTime || null;
        item.gcal_mins = item.gcal_start && item.gcal_end
          ? minsBetween(item.gcal_start, item.gcal_end) : null;
      }

      if (!item.event_id) {
        report.fail.push({ ...item, reason: 'no_event_id' });
        continue;
      }
      if (item.gcal_status !== 'confirmed') {
        report.fail.push({ ...item, reason: 'gcal_not_confirmed', err: ev?.error?.message });
        continue;
      }
      if (item.gcal_mins != null && Math.abs(item.gcal_mins - item.expect_mins) > 5) {
        report.warn.push({ ...item, reason: 'duration_mismatch' });
      } else {
        report.ok.push({ ...item, reason: 'pin_matches_gcal' });
      }
    }

    // Ghost check: GCal events whose start day is not near any pin / ideal window
    for (const e of gcalHits) {
      const start = e.start?.dateTime;
      if (!start) continue;
      const day = start.slice(0, 10);
      // allow if any latest pin points to this event id
      const linked = [...latest.values()].some((r) => r.calendar_event_id === e.id);
      const nearIdeal = ideals.some((id) => {
        const a = Date.parse(`${id}T12:00:00Z`);
        const b = Date.parse(`${day}T12:00:00Z`);
        return Math.abs(a - b) <= 21 * 86400000;
      });
      if (!linked && !nearIdeal) {
        report.warn.push({
          kind: 'possible_gcal_orphan',
          label: t.label,
          event_id: e.id,
          start,
          summary: e.summary,
        });
      }
    }
  }

  // Known cancelled ghosts must stay cancelled
  const ghosts = [
    ['ghost_bau1_aug17', 'e3dlram4mfmqvotmng8km2j580'],
    ['ghost_bau2_aug19', 'l6d5siuopnq2tjjbpcds1qe9ak'],
  ];
  for (const [label, id] of ghosts) {
    const ev = await getEvent(token, id);
    if (ev.status === 'cancelled') report.ok.push({ kind: 'ghost_cancelled', label });
    else report.fail.push({ kind: 'ghost_still_live', label, status: ev.status, start: ev.start });
  }

  // MC-20 spot check
  const mc20 = await getEvent(token, '17i499adai2vcrr5f74nikrsgc');
  const mc20ok = mc20.status === 'confirmed'
    && String(mc20.start?.dateTime || '').includes('2026-08-13T16:00');
  if (mc20ok) report.ok.push({ kind: 'mc20_heal_ok', start: mc20.start?.dateTime, end: mc20.end?.dateTime });
  else report.warn.push({ kind: 'mc20_check', start: mc20.start, end: mc20.end, status: mc20.status });

  console.log('\n========== SUMMARY ==========');
  console.log(JSON.stringify({
    ok: report.ok.length,
    warn: report.warn.length,
    fail: report.fail.length,
    fails: report.fail,
    warns: report.warn,
  }, null, 2));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
