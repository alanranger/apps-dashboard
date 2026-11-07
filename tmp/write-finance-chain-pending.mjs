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
const { londonYmdHmToUtcMs } = require('../api/mc/habit-placer-lib.js');

function hm(iso) {
  const m = isoToLondonMinutes(iso);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

const tasks = await sb(
  'tasks?select=display_id,title,scheduled_start,scheduled_end,calendar_event_id&display_id=in.(21,22,23)',
);
const byId = new Map(tasks.map((t) => [Number(t.display_id), t]));

/**
 * Cutoff: away 31 Jul–6 Aug → last working day Thu 30 Jul.
 * Same-day 21+22+23 impossible (need ~180m; only 105m gap on 30 Jul).
 * Dep-legal pack:
 *   MC-21 29 Jul 14:15–14:30 (gap before MC-9)
 *   MC-22 29 Jul 16:15–17:00 (after MC-9; after 21)
 *   MC-23 30 Jul 15:15–16:45 (only ≥90m pre-away gap; after 21)
 */
const plan = [
  {
    display_id: 21,
    new_day: '2026-07-29',
    new_start: new Date(londonYmdHmToUtcMs('2026-07-29', '14:15')).toISOString(),
    new_end: new Date(londonYmdHmToUtcMs('2026-07-29', '14:30')).toISOString(),
  },
  {
    display_id: 22,
    new_day: '2026-07-29',
    new_start: new Date(londonYmdHmToUtcMs('2026-07-29', '16:15')).toISOString(),
    new_end: new Date(londonYmdHmToUtcMs('2026-07-29', '17:00')).toISOString(),
  },
  {
    display_id: 23,
    new_day: '2026-07-30',
    new_start: new Date(londonYmdHmToUtcMs('2026-07-30', '15:15')).toISOString(),
    new_end: new Date(londonYmdHmToUtcMs('2026-07-30', '16:45')).toISOString(),
  },
];

const rows = [];
for (const p of plan) {
  const t = byId.get(p.display_id);
  const same = isoToLondonDate(t.scheduled_start) === p.new_day
    && hm(t.scheduled_start) === hm(p.new_start)
    && hm(t.scheduled_end) === hm(p.new_end);
  if (same) continue;
  const when = `${hm(p.new_start)}–${hm(p.new_end)}`;
  const was = `${isoToLondonDate(t.scheduled_start)} ${hm(t.scheduled_start)}–${hm(t.scheduled_end)}`;
  rows.push({
    change_type: 'task_bump',
    target_date: p.new_day,
    urgency: 'high',
    status: 'pending',
    related_id: `task_bump:finance:MC-${p.display_id}:${p.new_day}`,
    summary: `Finance re-bump MC-${p.display_id} → ${p.new_day} ${when}`,
    proposed_action: `MOVE MC-${p.display_id} ("${t.title}") event ${t.calendar_event_id} to ${p.new_day} ${when} (was ${was}). Update tasks.scheduled_start/end. Chain: 21→22 same day 29 Jul; 23 next day 30 Jul (only ≥90m gap). All ≤30 Jul pre-away.`,
    reason: 'Targeted finance-chain re-bump — deps + pre-away ≤30 Jul',
  });
}

let wrote = 0;
for (const row of rows) {
  const existing = await sb(
    `pending_diary_changes?status=eq.pending&change_type=eq.task_bump&related_id=eq.${encodeURIComponent(row.related_id)}&limit=1`,
  );
  if (Array.isArray(existing) && existing.length) continue;
  await sb('pending_diary_changes', { method: 'POST', body: row });
  wrote += 1;
}

const out = {
  ok: true,
  cutoff: '2026-07-30',
  challenge: 'Away 31 Jul–6 Aug → last working day = Thu 30 Jul (not Fri 31 Jul). Same-day pack of all three impossible (~180m needed; densest free block 105m).',
  pack: {
    'MC-21': '2026-07-29 14:15–14:30',
    'MC-22': '2026-07-29 16:15–17:00',
    'MC-23': '2026-07-30 15:15–16:45',
  },
  pending_wrote: wrote,
  rows,
  calendar_writes: 0,
};
console.log(JSON.stringify(out, null, 2));
fs.writeFileSync(path.join(root, 'tmp/finance-chain-rebump.json'), JSON.stringify(out, null, 2));
