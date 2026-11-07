/**
 * Re-pin BAU Day 1 + Day 2 on 2026-09-28 with 15m gap after Hotel bookings,
 * sticky as diary_manual_pin so Full Horizon cannot delete them.
 *
 * Hotel bookings — Alan actions: 11:00–11:30 London
 * Day 1 (90m): 11:45–13:15
 * Day 2 (120m): 13:30–15:30  (ideal remains 2026-09-29)
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
const { londonYmdHmToUtcMs } = require('../api/mc/habit-placer-lib.js');
const { applyHabitAmendmentToDb } = require('../api/mc/habit-placer-propose-lib.js');
const { buildFlushPlan, applyFlushPlan } = require('../api/mc/gcal-flush-lib.js');

const DAY1 = 'b002933c-0068-4dca-8661-f4098ccd714d';
const DAY2 = '65bb5023-40a3-4797-8e9c-e0b85f0581b6';

function iso(day, hm) {
  return new Date(londonYmdHmToUtcMs(day, hm)).toISOString();
}

async function stickManual(habitId, ideal) {
  const rows = await sb(
    `recurring_log?recurring_task_id=eq.${habitId}&ideal_date=eq.${ideal}`
    + '&select=id&order=at.desc&limit=1',
  );
  const id = rows?.[0]?.id;
  if (!id) return;
  await sb(`recurring_log?id=eq.${id}`, {
    method: 'PATCH', prefer: 'return=minimal',
    body: { roll_reason: 'diary_manual_pin' },
  });
}

async function cancelPendingDeletes(habitId, ideal) {
  const q = `gcal_push_queue?status=in.(pending,ready)`
    + `&entity_type=eq.habit`
    + `&related_id=like.*${habitId}*${ideal}*`
    + '&select=id,change_kind,summary,status';
  const rows = await sb(q).catch(() => []) || [];
  for (const r of rows) {
    if (String(r.change_kind || '') !== 'skip' && !/unplace|DELETE/i.test(String(r.summary || ''))) continue;
    await sb(`gcal_push_queue?id=eq.${r.id}`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: {
        status: 'cancelled',
        updated_at: new Date().toISOString(),
        last_error: 'superseded: sticky manual re-pin 2026-09-25',
      },
    }).catch(() => {});
  }
}

const day = '2026-09-28';
const plan = [
  {
    habit_id: DAY1,
    title: 'BAU global refresh — Day 1: CSVs + preliminary ingest',
    ideal_date: '2026-09-28',
    startIso: iso(day, '11:45'),
    endIso: iso(day, '13:15'),
  },
  {
    habit_id: DAY2,
    title: 'BAU global refresh — Day 2: schemas + final ingest + verify',
    ideal_date: '2026-09-29',
    startIso: iso(day, '13:30'),
    endIso: iso(day, '15:30'),
  },
];

console.log('=== Re-pin BAU on 2026-09-28 (15m after Hotel 11:00–11:30) ===');
for (const p of plan) {
  await cancelPendingDeletes(p.habit_id, p.ideal_date);
  const ok = await applyHabitAmendmentToDb(sb, {
    action: 'CREATE',
    habit_id: p.habit_id,
    title: p.title,
    ideal_date: p.ideal_date,
    startIso: p.startIso,
    endIso: p.endIso,
    calendar_event_id: null,
  });
  await stickManual(p.habit_id, p.ideal_date);
  await sb(`recurring_tasks?id=eq.${p.habit_id}`, {
    method: 'PATCH', prefer: 'return=minimal',
    body: {
      last_scheduled: day,
      scheduled_note: `${day} ${p.startIso.slice(11, 16)} (diary pin)`,
      updated_at: new Date().toISOString(),
    },
  });
  console.log(ok ? 'pinned' : 'pin skipped?', p.title, p.startIso, '→', p.endIso);
}

console.log('Flushing gcal_push_queue…');
const planFlush = await buildFlushPlan(sb, { includeBacklog: false });
const flush = await applyFlushPlan(sb, planFlush, 'cursor-bau-repin', { limit: 40 });
console.log('flush applied', flush.applied, 'failed', flush.failed);
if (flush.results?.length) {
  for (const r of flush.results.slice(0, 10)) {
    console.log(r.ok ? 'ok' : 'FAIL', r.summary || r.title || r.related_id, r.error || r.event_id || '');
  }
}

for (const p of plan) {
  const log = await sb(
    `recurring_log?recurring_task_id=eq.${p.habit_id}&ideal_date=eq.${p.ideal_date}`
    + '&select=change,scheduled_date,roll_reason,calendar_event_id&order=at.desc&limit=1',
  );
  console.log('log', p.ideal_date, log?.[0]);
}
