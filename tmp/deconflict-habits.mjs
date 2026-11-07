/**
 * Deconflict overlapping habits on a day — pin later habit after earlier + gap.
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
const { relatedIdForHabit, upsertPushRow } = require('../api/mc/gcal-push-lib.js');
const { isoToLondonMinutes } = require('../api/mc/scheduling-rules-lib.js');

const DAYS = ['2026-08-10', '2026-08-14'];
const GAP = 30;

function parsePin(change) {
  const m = /^diary_pin:(.+)\|(.+)$/.exec(String(change || ''));
  return m ? { start: m[1], end: m[2] } : null;
}

function overlaps(a0, a1, b0, b1) {
  return a0 < b1 && b0 < a1;
}

const moved = [];
for (const day of DAYS) {
  const logs = await sb(
    `recurring_log?scheduled_date=eq.${day}&select=id,recurring_task_id,ideal_date,scheduled_date,calendar_event_id,change`
    + '&order=at.asc',
  );
  const habits = await sb('recurring_tasks?select=id,title,duration_min,ideal_time,priority&active=eq.true');
  const byId = new Map((habits || []).map((h) => [h.id, h]));
  const blocks = [];
  for (const log of logs || []) {
    const c = String(log.change || '');
    if (/^skipped/i.test(c) || /^completed/i.test(c)) continue;
    const h = byId.get(log.recurring_task_id);
    if (!h) continue;
    const dur = Number(h.duration_min) || 60;
    const pin = parsePin(c);
    let startIso;
    let endIso;
    if (pin) {
      startIso = pin.start;
      endIso = pin.end;
    } else {
      const hm = String(h.ideal_time || '09:00').slice(0, 5);
      const ms = londonYmdHmToUtcMs(day, hm);
      startIso = new Date(ms).toISOString();
      endIso = new Date(ms + dur * 60000).toISOString();
    }
    blocks.push({
      log, habit: h, startIso, endIso,
      startMs: Date.parse(startIso), endMs: Date.parse(endIso),
      priority: h.priority || 'p2',
    });
  }
  blocks.sort((a, b) => a.startMs - b.startMs
    || String(a.priority).localeCompare(String(b.priority))
    || a.habit.title.localeCompare(b.habit.title));

  for (let i = 0; i < blocks.length; i += 1) {
    for (let j = i + 1; j < blocks.length; j += 1) {
      const a = blocks[i];
      const b = blocks[j];
      if (!overlaps(a.startMs, a.endMs, b.startMs, b.endMs)) continue;
      // Move later/lower-priority block to after a + gap
      const newStartMs = a.endMs + GAP * 60000;
      const dur = Math.max(15, Math.round((b.endMs - b.startMs) / 60000));
      const newEndMs = newStartMs + dur * 60000;
      const newStart = new Date(newStartMs).toISOString();
      const newEnd = new Date(newEndMs).toISOString();
      const pinChange = `diary_pin:${newStart}|${newEnd}`;
      await sb(`recurring_log?id=eq.${b.log.id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: {
          change: pinChange,
          scheduled_date: day,
          roll_reason: 'conflict_deconflict',
        },
      });
      await upsertPushRow(sb, {
        related_id: relatedIdForHabit(b.habit.id, b.log.ideal_date || day, b.log.calendar_event_id),
        entity_type: 'habit',
        change_kind: 'move',
        summary: `Deconflict ${b.habit.title} on ${day}`,
        proposed_action: `MOVE habit "${b.habit.title}" to ${newStart}–${newEnd} (was overlapping "${a.habit.title}").`,
        payload: {
          habit_id: b.habit.id,
          from: { start: b.startIso, end: b.endIso },
          new_start: newStart,
          new_end: newEnd,
          reason: 'habit_conflict_deconflict',
        },
      });
      b.startIso = newStart;
      b.endIso = newEnd;
      b.startMs = newStartMs;
      b.endMs = newEndMs;
      moved.push({
        day, title: b.habit.title, after: a.habit.title, newStart, newEnd,
      });
    }
  }
}

console.log(JSON.stringify({ moved }, null, 2));
