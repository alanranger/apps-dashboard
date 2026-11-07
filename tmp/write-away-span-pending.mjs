/**
 * Write pending only for away-span affected windows (David Ward / Norfolk / Jan LD).
 * Reads spike JSON from last dry run. No calendar writes.
 *
 * Usage: node tmp/write-away-span-pending.mjs
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
const { isoToLondonDate } = require('../api/mc/scheduling-rules-lib.js');
const { amendmentToPending, bumpToPending } = require('../api/mc/habit-placer-propose-lib.js');

const spike = JSON.parse(
  fs.readFileSync(path.join(root, 'tmp/habit-placer-spike-2026-07-26.json'), 'utf8'),
);

function affectedDay(d) {
  if (!d) return false;
  return (d >= '2026-08-03' && d <= '2026-08-08')
    || (d >= '2026-11-18' && d <= '2026-11-24')
    || (d >= '2027-01-20' && d <= '2027-01-25');
}

function amendmentAffected(a) {
  const from = a.from_startIso ? isoToLondonDate(a.from_startIso) : null;
  const to = a.startIso ? isoToLondonDate(a.startIso) : null;
  return affectedDay(from) || affectedDay(to) || affectedDay(a.ideal_date);
}

function bumpAffected(b) {
  return affectedDay(b.new_day) || affectedDay(b.habit_day)
    || affectedDay(b.task_start && isoToLondonDate(b.task_start));
}

async function exists(changeType, relatedId) {
  const rows = await sb(
    `pending_diary_changes?status=eq.pending&change_type=eq.${encodeURIComponent(changeType)}`
    + `&related_id=eq.${encodeURIComponent(relatedId)}&limit=1`,
  );
  return Array.isArray(rows) && rows.length > 0;
}

const amendments = (spike.amendments || []).filter((a) => a.action !== 'KEEP' && amendmentAffected(a));
const bumps = (spike.task_bumps || []).filter(bumpAffected);

let wrote = 0;
const rows = [];
for (const a of amendments) {
  const row = amendmentToPending(a);
  if (!row) continue;
  if (await exists(row.change_type, row.related_id)) continue;
  await sb('pending_diary_changes', { method: 'POST', body: row });
  wrote += 1;
  rows.push(row.related_id);
}
for (const b of bumps) {
  const row = bumpToPending(b);
  if (await exists(row.change_type, row.related_id)) continue;
  await sb('pending_diary_changes', { method: 'POST', body: row });
  wrote += 1;
  rows.push(row.related_id);
}

const out = {
  ok: true,
  calendar_writes: 0,
  proof_ok: spike.proof?.ok,
  away_span_count: spike.away_span_count,
  affected_amendments: amendments.length,
  affected_bumps: bumps.length,
  pending_wrote: wrote,
  related_ids: rows,
  clean_window_flagged: (spike.amendments || []).filter((a) => {
    if (a.action === 'KEEP') return false;
    const from = a.from_startIso ? isoToLondonDate(a.from_startIso) : null;
    const to = a.startIso ? isoToLondonDate(a.startIso) : null;
    const ranges = [
      ['2026-09-17', '2026-09-21'], ['2026-09-25', '2026-09-28'],
      ['2026-10-01', '2026-10-05'], ['2026-10-09', '2026-10-12'],
      ['2026-11-12', '2026-11-16'],
    ];
    const near = (d) => ranges.some(([x, y]) => d && d >= x && d <= y);
    return near(from) || near(to) || near(a.ideal_date);
  }).map((a) => ({
    action: a.action, title: a.title, ideal: a.ideal_date,
    from: a.from_startIso && isoToLondonDate(a.from_startIso),
    to: a.startIso && isoToLondonDate(a.startIso),
  })),
};
console.log(JSON.stringify(out, null, 2));
fs.writeFileSync(path.join(root, 'tmp/away-span-pending.json'), JSON.stringify(out, null, 2));
