/**
 * Place Upload with full habit set + deps (correct dep context).
 * node scripts/mc-force-upload.cjs
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { sb } = require('../api/mc/_lib');
const { placeHabits } = require('../api/mc/habit-placer-lib');
const { runPlacerWindow } = require('../api/mc/habit-placer-window-lib');
const { pushSync, loadFlags } = require('../api/mc/gcal-auto-sync-lib');
const { bankHolidaySet, holidaySetFromRows } = require('../api/mc/scheduling-rules-lib');
const { getAccessToken } = require('../api/mc/gcal-lib');

const ANCHOR = '2026-07-30';
const UPLOAD_ID = 'e6d11356-6276-48af-a5d3-58874c31ce5d';

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

  const { placements, unplaced } = placeHabits(
    habits || [], deps || [], [], ruleMap, holidays, '2026-08-01', '2027-02-28',
    { softTaskIntervals: [], existingHabitIntervals: [], phaseAnchorYmd: ANCHOR },
  );
  const up = placements.filter((p) => p.habit_id === UPLOAD_ID);
  const uu = unplaced.filter((u) => u.habit_id === UPLOAD_ID);
  console.log('dry_upload_placements', up);
  console.log('dry_upload_unplaced', uu);
  console.log('dry_bau', placements.filter((p) => /BAU/i.test(p.title)).map((p) => ({
    title: p.title, ideal: p.ideal_date, day: p.day, start: p.startIso,
  })));

  // Live placer windows covering each Upload ideal (wider so BAU fits too)
  const windows = [
    ['2026-08-20', '2026-09-15'],
    ['2026-10-15', '2026-11-15'],
    ['2026-12-10', '2027-01-15'],
    ['2027-02-01', '2027-02-28'],
  ];
  for (const [from, to] of windows) {
    const placer = await runPlacerWindow(sb, from, to, { phaseAnchorYmd: ANCHOR });
    console.log('placer', {
      from, to, skipped: placer.skipped, reason: placer.reason,
      pending_wrote: placer.pending_wrote, unplaced: placer.unplaced,
      create: placer.create, move: placer.move, delete: placer.delete,
    });
  }

  await sb(`scheduling_rules?key=eq.${encodeURIComponent('gcal_push_inflight_until')}`, {
    method: 'PATCH', prefer: 'return=minimal',
    body: { value: '0', updated_at: new Date().toISOString() },
  }).catch(() => {});
  console.log('flags', await loadFlags(sb));
  for (let i = 1; i <= 8; i += 1) {
    const flush = await pushSync(sb, `cursor-upload-${i}`, {
      includeBacklog: true, includeRuleMasters: false,
    });
    const planned = flush.flush?.planned ?? 0;
    const applied = flush.flush?.applied ?? 0;
    const failed = flush.flush?.failed ?? 0;
    console.log(`flush ${i}`, { planned, applied, failed });
    if (!planned && !applied) break;
  }

  const logs = await sb(
    `recurring_log?recurring_task_id=eq.${UPLOAD_ID}&ideal_date=gte.2026-07-30&select=ideal_date,scheduled_date,change,calendar_event_id,at&order=at.desc&limit=40`,
  );
  const latest = new Map();
  for (const row of logs || []) {
    if (!latest.has(row.ideal_date)) latest.set(row.ideal_date, row);
  }
  console.log('upload_latest', [...latest.entries()].sort((a, b) => a[0].localeCompare(b[0])));

  const token = await getAccessToken();
  const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime`
    + `&timeMin=${encodeURIComponent('2026-08-01T00:00:00Z')}`
    + `&timeMax=${encodeURIComponent('2027-03-01T00:00:00Z')}`
    + `&q=${encodeURIComponent('Upload sites')}&maxResults=20`;
  const j = await fetch(url, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());
  console.log('gcal_upload', (j.items || []).map((e) => ({
    id: e.id, status: e.status,
    start: e.start?.dateTime || e.start?.date,
    end: e.end?.dateTime || e.end?.date,
  })));

  const pending = await sb('gcal_push_queue?status=eq.pending&select=id,summary&limit=10');
  console.log('pending', pending);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
