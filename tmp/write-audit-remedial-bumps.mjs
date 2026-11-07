/**
 * Write remedial task_bumps for post-apply audit fails (Aug 7 pack + MC-51 away).
 * No calendar writes.
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

function hm(iso) {
  const m = isoToLondonMinutes(iso);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

const tasks = await sb(
  'tasks?select=display_id,title,scheduled_start,scheduled_end,calendar_event_id'
  + '&display_id=in.(1,2,13,51)',
);
const byId = new Map(tasks.map((t) => [Number(t.display_id), t]));

const plan = [
  {
    display_id: 13,
    new_day: '2026-08-09',
    new_start: '2026-08-09T08:00:00.000Z',
    new_end: '2026-08-09T08:30:00.000Z',
    reason: 'Audit fix — Aug 7 return-day pack (overlap MC-2 + cap)',
  },
  {
    display_id: 2,
    new_day: '2026-08-09',
    new_start: '2026-08-09T08:30:00.000Z',
    new_end: '2026-08-09T09:15:00.000Z',
    reason: 'Audit fix — Aug 7 return-day pack (overlap MC-13 + cap)',
  },
  {
    display_id: 1,
    new_day: '2026-08-09',
    new_start: '2026-08-09T09:15:00.000Z',
    new_end: '2026-08-09T10:15:00.000Z',
    reason: 'Audit fix — Aug 7 return-day pack (cap)',
  },
  {
    display_id: 51,
    new_day: '2026-08-17',
    new_start: '2026-08-17T08:00:00.000Z',
    new_end: '2026-08-17T09:00:00.000Z',
    reason: 'Audit fix — on Surprise View away day 16 Aug',
  },
];

let wrote = 0;
const rows = [];
for (const p of plan) {
  const t = byId.get(p.display_id);
  const related_id = `task_bump:audit:MC-${p.display_id}:${p.new_day}`;
  const existing = await sb(
    `pending_diary_changes?status=eq.pending&related_id=eq.${encodeURIComponent(related_id)}&limit=1`,
  );
  if (Array.isArray(existing) && existing.length) {
    rows.push({ related_id, already: true });
    continue;
  }
  const was = `${isoToLondonDate(t.scheduled_start)} ${hm(t.scheduled_start)}–${hm(t.scheduled_end)}`;
  const when = `${hm(p.new_start)}–${hm(p.new_end)}`;
  const row = {
    change_type: 'task_bump',
    target_date: p.new_day,
    urgency: 'high',
    status: 'pending',
    related_id,
    summary: `Audit bump MC-${p.display_id} → ${p.new_day} ${when}`,
    proposed_action:
      `MOVE MC-${p.display_id} ("${t.title}") event ${t.calendar_event_id} to ${p.new_day} ${when} `
      + `(was ${was}). Update tasks.scheduled_start/end.`,
    reason: p.reason,
  };
  await sb('pending_diary_changes', { method: 'POST', body: row });
  wrote += 1;
  rows.push({ related_id, summary: row.summary });
}

console.log(JSON.stringify({ ok: true, calendar_writes: 0, wrote, rows }, null, 2));
