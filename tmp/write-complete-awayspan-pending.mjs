/**
 * Write COMPLETE away-span pending set (full horizon, all cascades).
 * Also ensure David Ward travel_back GCal MOVE is pending.
 * Usage: node tmp/write-complete-awayspan-pending.mjs
 */
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
const { isoToLondonDate, isoToLondonMinutes } = require('../api/mc/scheduling-rules-lib.js');
const { amendmentToPending, bumpToPending } = require('../api/mc/habit-placer-propose-lib.js');

const spike = JSON.parse(
  fs.readFileSync(path.join(root, 'tmp/habit-placer-spike-2026-07-26.json'), 'utf8'),
);

function hm(iso) {
  const m = isoToLondonMinutes(iso);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

async function exists(changeType, relatedId) {
  const rows = await sb(
    `pending_diary_changes?status=eq.pending&change_type=eq.${encodeURIComponent(changeType)}`
    + `&related_id=eq.${encodeURIComponent(relatedId)}&limit=1`,
  );
  return Array.isArray(rows) && rows.length > 0;
}

async function writeRow(row) {
  if (await exists(row.change_type, row.related_id)) return false;
  await sb('pending_diary_changes', { method: 'POST', body: row });
  return true;
}

const amendments = (spike.amendments || []).filter((a) => a.action !== 'KEEP');
const bumps = spike.task_bumps || [];

let wrote = 0;
let skipped = 0;
const related = [];

for (const a of amendments) {
  const row = amendmentToPending(a);
  if (!row) continue;
  if (await writeRow(row)) {
    wrote += 1;
    related.push({ type: row.change_type, id: row.related_id, summary: row.summary });
  } else {
    skipped += 1;
    related.push({ type: row.change_type, id: row.related_id, summary: row.summary, already: true });
  }
}

for (const b of bumps) {
  const row = bumpToPending(b);
  if (await writeRow(row)) {
    wrote += 1;
    related.push({ type: row.change_type, id: row.related_id, summary: row.summary });
  } else {
    skipped += 1;
    related.push({ type: row.change_type, id: row.related_id, summary: row.summary, already: true });
  }
}

// David Ward travel_back GCal sync (DB already corrected; Claude moves event).
const travelRow = {
  change_type: 'missing_travel_block',
  target_date: '2026-08-06',
  urgency: 'high',
  status: 'pending',
  related_id: 'travel_back_fix:rosedale:2026-08-06',
  summary: 'FIX travel_back David Ward / Rosedale — depart 17:00 not 14:00',
  proposed_action:
    'MOVE Primary event m2svuf0fekgo1lpnnl7pfijok4 to 2026-08-06 17:00–20:15 London '
    + '(was 14:00–17:15). Workshop runs to 17:00 on 6 Aug. travel_blocks row '
    + '488e0176-d17a-4691-85c9-8516201dfdc7 already updated to 16:00–19:15Z.',
  reason: 'Alan-confirmed: David Ward workshop 09:00–17:00 on 4/5/6 Aug',
};
if (await writeRow(travelRow)) {
  wrote += 1;
  related.push({ type: travelRow.change_type, id: travelRow.related_id, summary: travelRow.summary });
} else {
  skipped += 1;
  related.push({
    type: travelRow.change_type, id: travelRow.related_id, summary: travelRow.summary, already: true,
  });
}

// Trip coverage from amendments + away spans
const tripHints = [];
for (const s of spike.away_spans || []) {
  const touches = amendments.filter((a) => {
    const from = a.from_startIso ? isoToLondonDate(a.from_startIso) : null;
    const to = a.startIso ? isoToLondonDate(a.startIso) : null;
    const inSpan = (d) => d && d >= s.startDay && d <= s.endDay;
    const near = (d) => d && d >= addDays(s.startDay, -2) && d <= addDays(s.endDay, 2);
    return inSpan(from) || inSpan(to) || near(from) || near(to) || near(a.ideal_date);
  });
  tripHints.push({
    span: s.summary,
    days: `${s.startDay}→${s.endDay}`,
    amendment_count: touches.length,
    titles: [...new Set(touches.map((t) => t.title))],
  });
}

function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

const out = {
  ok: true,
  calendar_writes: 0,
  proof_ok: spike.proof?.ok,
  away_span_count: spike.away_span_count,
  amendment_counts: spike.amendment_counts,
  habit_amendments_non_keep: amendments.length,
  task_bumps: bumps.length,
  travel_back_fix: 1,
  pending_wrote_new: wrote,
  pending_already_present: skipped,
  pending_total_in_set: related.length,
  related,
  trips_touched: tripHints.filter((t) => t.amendment_count > 0),
  trips_untouched: tripHints.filter((t) => t.amendment_count === 0),
  sample_moves: amendments.slice(0, 40).map((a) => ({
    action: a.action,
    title: a.title,
    ideal: a.ideal_date,
    from: a.from_startIso
      ? `${isoToLondonDate(a.from_startIso)} ${hm(a.from_startIso)}`
      : null,
    to: a.startIso ? `${isoToLondonDate(a.startIso)} ${hm(a.startIso)}` : null,
  })),
};
console.log(JSON.stringify(out, null, 2));
fs.writeFileSync(path.join(root, 'tmp/complete-awayspan-pending.json'), JSON.stringify(out, null, 2));
