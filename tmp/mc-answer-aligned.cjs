const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { sb } = require('../api/mc/_lib');
const { reconcileReport } = require('../api/mc/gcal-auto-sync-lib');
const { fetchHorizonEvents } = require('../api/mc/gcal-lib');
const { getPrimaryEvent } = require('../api/mc/gcal-write-lib');

(async () => {
  const report = await reconcileReport(sb);
  const habitTaskMismatches = (report.mismatches || []).filter((m) => m.kind === 'habit' || m.kind === 'task');
  const travelMismatches = (report.mismatches || []).filter((m) => m.kind === 'travel');

  // Spot-check the week Alan circled (17–23 Aug)
  const { events } = await fetchHorizonEvents('2026-08-17T00:00:00.000Z', '2026-08-24T00:00:00.000Z');
  const primary = (events || []).filter((e) => (e._calendarId || 'primary') === 'primary' && e.start?.dateTime);
  const pins = await sb(
    "recurring_log?select=ideal_date,scheduled_date,change,calendar_event_id,recurring_task_id"
    + "&scheduled_date=gte.2026-08-17&scheduled_date=lte.2026-08-23"
    + "&change=like.diary_pin:*&order=scheduled_date.asc",
  ) || [];

  let weekPinOk = 0;
  let weekPinBad = 0;
  const weekIssues = [];
  const seen = new Set();
  for (const p of pins) {
    const m = String(p.change || '').match(/^diary_pin:([^|]+)\|([^|]+)/);
    if (!m || !p.calendar_event_id) continue;
    const key = `${p.recurring_task_id}|${p.ideal_date || p.scheduled_date}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const live = await getPrimaryEvent(p.calendar_event_id);
      if (!live || live.status === 'cancelled') {
        weekPinBad += 1;
        weekIssues.push({ title: p.change, issue: 'missing_on_gcal', id: p.calendar_event_id });
        continue;
      }
      const ls = live.start?.dateTime;
      const le = live.end?.dateTime;
      const drift = Math.max(
        Math.abs(Date.parse(ls) - Date.parse(m[1])),
        Math.abs(Date.parse(le) - Date.parse(m[2])),
      ) / 60000;
      if (drift > 5) {
        weekPinBad += 1;
        weekIssues.push({ scheduled: p.scheduled_date, drift_min: Math.round(drift), pin: m[1], gcal: ls });
      } else weekPinOk += 1;
    } catch (e) {
      weekPinBad += 1;
      weekIssues.push({ id: p.calendar_event_id, issue: e.message });
    }
  }

  console.log(JSON.stringify({
    google_matches_db_habits_tasks: habitTaskMismatches.length === 0,
    habit_task_mismatch_count: habitTaskMismatches.length,
    travel_mismatch_count: travelMismatches.length,
    masters_missing_event_id: report.masters_missing_event_id,
    pending_flush_writes: report.pending_flush_writes,
    week_17_23_aug: {
      primary_timed_events: primary.length,
      pins_checked: weekPinOk + weekPinBad,
      pins_match_gcal: weekPinOk,
      pins_mismatch: weekPinBad,
      issues: weekIssues.slice(0, 10),
    },
    status_line: report.status_line,
    remaining_mismatches: report.mismatches,
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
