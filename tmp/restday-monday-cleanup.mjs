/**
 * Re-solve stale restday_monday_resolve pins under current rest-day +
 * forward/backward anchor rules. DB + gcal_push_queue only.
 *
 * Usage: node tmp/restday-monday-cleanup.mjs [--dry]
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
const { ruleMapFromRows, bankHolidaySet, isoToLondonDate, addDays, isSchedulableDay } = require('../api/mc/scheduling-rules-lib.js');
const {
  awaySpansFromTravelBlocks, restDaySpansFromWorkshopEvents, teachingDaySpansFromEvents,
  buildBusyIntervals, datedTasksToIntervals, trySlotOnDay, londonYmdHmToUtcMs,
  candidateDays, criticalRollMode, dayBlockedForPlacement,
} = require('../api/mc/habit-placer-lib.js');
const { relatedIdForHabit, upsertPushRow } = require('../api/mc/gcal-push-lib.js');
const { gcalConfigured, fetchHorizonEvents } = require('../api/mc/gcal-lib.js');

const FROM = '2026-07-01';
const TO = '2027-01-15';
const REASON = 'restday_monday_cleanup';

function parsePin(change, habit, day) {
  const pin = /^diary_pin:(.+)\|(.+)$/.exec(String(change || ''));
  if (pin) return { startIso: pin[1], endIso: pin[2] };
  const hm = String(habit.ideal_time || '09:00').slice(0, 5);
  const startMs = londonYmdHmToUtcMs(day, hm);
  const dur = Number(habit.duration_min) || 60;
  return { startIso: new Date(startMs).toISOString(), endIso: new Date(startMs + dur * 60000).toISOString() };
}

function offsetDays(a, b) {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);
}

async function main() {
  const dry = process.argv.includes('--dry');
  const ruleMap = ruleMapFromRows(await sb('scheduling_rules?select=key,value'));
  const holidays = bankHolidaySet(2026, 2027);

  const travel = await sb(
    'travel_blocks?select=block_type,starts_at,ends_at,venue_name,workshop_title,workshop_start,workshop_row_key'
    + `&block_type=in.(travel_out,travel_back)&starts_at=gte.${FROM}T00:00:00Z&starts_at=lte.${TO}T23:59:59Z`,
  );
  if (!gcalConfigured()) throw new Error('GCAL required');
  const { events } = await fetchHorizonEvents(`${FROM}T00:00:00.000Z`, `${TO}T23:59:59.000Z`);
  const awaySpans = awaySpansFromTravelBlocks(travel || []);
  const rests = restDaySpansFromWorkshopEvents(events || [], ruleMap);
  const teaching = teachingDaySpansFromEvents(events || [], ruleMap);
  const blockedSpans = awaySpans.concat(rests).concat(teaching);

  const tasks = await sb(
    'tasks?select=display_id,title,state,slot_pinned,scheduled_start,scheduled_end'
    + `&scheduled_start=gte.${FROM}T00:00:00Z&scheduled_start=lte.${TO}T23:59:59Z`
    + '&state=not.in.(done,verified,wont_do,superseded)',
  );
  let busy = buildBusyIntervals(events || [], ruleMap)
    .concat(datedTasksToIntervals(tasks || [], { pinnedOnly: true }))
    .concat(datedTasksToIntervals(tasks || [], { pinnedOnly: false }))
    .concat(blockedSpans)
    .sort((a, b) => a.startMs - b.startMs);

  const stale = await sb(
    "recurring_log?roll_reason=eq.restday_monday_resolve&select=id,recurring_task_id,ideal_date,scheduled_date,calendar_event_id,change,projection_key&order=ideal_date.asc",
  );
  if (!stale?.length) {
    console.log(JSON.stringify({ dry, moved: 0, note: 'no stale rows' }, null, 2));
    return;
  }
  const targetIds = new Set(stale.map((r) => r.id));
  const habitIds = [...new Set(stale.map((r) => r.recurring_task_id))];
  const habits = await sb(
    `recurring_tasks?id=in.(${habitIds.map((id) => `"${id}"`).join(',')})`
    + '&select=id,title,duration_min,ideal_time,window_days,time_critical,rrule,priority',
  );
  const habitById = new Map((habits || []).map((h) => [h.id, h]));

  // Other habit placements as decompress occupancy (exclude stale targets).
  const allLogs = await sb(
    `recurring_log?scheduled_date=gte.${FROM}&scheduled_date=lte.${TO}`
    + '&select=id,recurring_task_id,scheduled_date,change&order=scheduled_date.asc&limit=8000',
  );
  const placed = [];
  const dayUsed = {};
  for (const log of allLogs || []) {
    if (targetIds.has(log.id)) continue;
    const c = String(log.change || '');
    if (/^skipped/i.test(c) || /^completed/i.test(c)) continue;
    const habit = habitById.get(log.recurring_task_id)
      || (await ensureHabit(habitById, log.recurring_task_id));
    if (!habit) continue;
    const day = log.scheduled_date;
    const { startIso, endIso } = parsePin(c, habit, day);
    const dur = Math.max(1, (Date.parse(endIso) - Date.parse(startIso)) / 60000);
    placed.push({
      day, startIso, endIso, durationMin: dur, title: habit.title,
    });
    dayUsed[day] = (dayUsed[day] || 0) + dur;
  }

  // Protect forward_anchor_correct rows from being treated as free.
  const protectedLogs = await sb(
    "recurring_log?roll_reason=eq.forward_anchor_correct&select=id,scheduled_date,change,recurring_task_id",
  );
  for (const log of protectedLogs || []) {
    if (targetIds.has(log.id)) continue;
    const habit = await ensureHabit(habitById, log.recurring_task_id);
    if (!habit) continue;
    const { startIso, endIso } = parsePin(log.change, habit, log.scheduled_date);
    const dur = Math.max(1, (Date.parse(endIso) - Date.parse(startIso)) / 60000);
    placed.push({
      day: log.scheduled_date, startIso, endIso, durationMin: dur, title: habit.title,
    });
    dayUsed[log.scheduled_date] = (dayUsed[log.scheduled_date] || 0) + dur;
  }

  const report = [];
  const awayBefore = await sb('pending_diary_changes?status=eq.pending&select=id');
  const awayCountBefore = (awayBefore || []).length;
  const faBefore = await sb(
    "recurring_log?roll_reason=eq.forward_anchor_correct&select=id,scheduled_date,ideal_date",
  );

  for (const row of stale) {
    const habit = habitById.get(row.recurring_task_id);
    if (!habit) {
      report.push({ id: row.id, error: 'habit missing' });
      continue;
    }
    const ideal = row.ideal_date;
    const mode = criticalRollMode(habit.rrule, habit.time_critical === true);
    let days = candidateDays(
      ideal, habit.window_days, habit.time_critical === true, ruleMap, holidays,
      blockedSpans, habit.rrule,
    );
    // Cleanup grace (+14d forward / flexible only). Deadline backward stays in window_days.
    const extra = [];
    const grace = mode === 'backward' ? Math.max(0, Number(habit.window_days) || 0) : 14;
    for (let i = 0; i <= grace; i += 1) {
      if (mode !== 'backward') extra.push(addDays(ideal, i));
      if (mode !== 'forward') extra.push(addDays(ideal, -i));
    }
    days = [...new Set(days.concat(extra))].filter((d) => {
      if (mode === 'forward' && d < ideal) return false;
      if (mode === 'backward' && d > ideal) return false;
      return isSchedulableDay(d, ruleMap, holidays) && !dayBlockedForPlacement(d, blockedSpans);
    });
    // Prefer closer to ideal.
    days.sort((a, b) => Math.abs(offsetDays(ideal, a)) - Math.abs(offsetDays(ideal, b))
      || String(a).localeCompare(String(b)));
    let slot = null;
    for (const day of days) {
      const trial = trySlotOnDay(
        day, Number(habit.duration_min) || 60, habit.ideal_time || '09:00',
        habit.title, busy, placed, dayUsed, ruleMap,
      );
      if (trial) { slot = trial; break; }
    }
    if (!slot) {
      report.push({
        title: habit.title, ideal_date: ideal,
        old_scheduled: row.scheduled_date,
        old_offset: offsetDays(ideal, row.scheduled_date),
        new_scheduled: null, reason: 'UNPLACEABLE',
        mode: criticalRollMode(habit.rrule, habit.time_critical === true),
      });
      continue;
    }

    const oldOff = offsetDays(ideal, row.scheduled_date);
    const newOff = offsetDays(ideal, slot.day);
    const same = row.scheduled_date === slot.day
      && String(row.change || '').includes(slot.startIso);
    const entry = {
      title: habit.title,
      ideal_date: ideal,
      old_scheduled: row.scheduled_date,
      old_offset: oldOff,
      new_scheduled: slot.day,
      new_offset: newOff,
      new_start: slot.startIso,
      new_end: slot.endIso,
      reason: REASON,
      mode: criticalRollMode(habit.rrule, habit.time_critical === true),
      unchanged: same,
    };
    report.push(entry);

    if (dry || same) {
      // Still retire roll_reason even if day unchanged (clear stale label).
      if (!dry && same) {
        await sb(`recurring_log?id=eq.${row.id}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: { roll_reason: REASON, projection_key: `cleanup:${habit.id}:${ideal}` },
        });
      }
      continue;
    }

    const pinChange = `diary_pin:${slot.startIso}|${slot.endIso}`;
    await sb(`recurring_log?id=eq.${row.id}`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: {
        scheduled_date: slot.day,
        change: pinChange,
        roll_reason: REASON,
        projection_key: `cleanup:${habit.id}:${ideal}`,
      },
    });

    const related = relatedIdForHabit(habit.id, ideal, row.calendar_event_id || null);
    await upsertPushRow(sb, {
      related_id: related,
      entity_type: 'habit',
      change_kind: 'move',
      summary: `Move habit ${habit.title} → ${slot.day}`,
      proposed_action: [
        `MOVE/CREATE habit "${habit.title}" block to ${slot.startIso} – ${slot.endIso}.`,
        row.calendar_event_id ? `event_id=${row.calendar_event_id}` : 'Create Primary event',
        `ideal_date=${ideal}; scheduled_date=${slot.day}. ${REASON}`,
      ].join(' '),
      payload: {
        habit_id: habit.id,
        title: habit.title,
        ideal_date: ideal,
        new_start: slot.startIso,
        new_end: slot.endIso,
        calendar_event_id: row.calendar_event_id || null,
        reason: REASON,
      },
    });

    placed.push({
      day: slot.day, startIso: slot.startIso, endIso: slot.endIso,
      durationMin: slot.durationMin, title: habit.title,
    });
    dayUsed[slot.day] = (dayUsed[slot.day] || 0) + slot.durationMin;
    busy = busy.concat([{
      startMs: Date.parse(slot.startIso), endMs: Date.parse(slot.endIso),
      kind: 'habit', title: habit.title,
    }]).sort((a, b) => a.startMs - b.startMs);
  }

  // Retire any remaining restday_monday_resolve labels if dry skipped updates.
  if (!dry) {
    const left = await sb(
      "recurring_log?roll_reason=eq.restday_monday_resolve&select=id",
    );
    for (const r of left || []) {
      await sb(`recurring_log?id=eq.${r.id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: { roll_reason: REASON },
      });
    }
  }

  const leftCount = dry ? stale.length : (
    await sb("recurring_log?roll_reason=eq.restday_monday_resolve&select=id")
  )?.length || 0;
  const awayAfter = await sb('pending_diary_changes?status=eq.pending&select=id');
  const faAfter = await sb(
    "recurring_log?roll_reason=eq.forward_anchor_correct&select=id,scheduled_date,ideal_date",
  );
  const faSame = JSON.stringify(faBefore) === JSON.stringify(faAfter);

  const out = {
    dry,
    stale: stale.length,
    moved: report.filter((r) => r.new_scheduled && !r.unchanged && !r.error).length,
    unchanged: report.filter((r) => r.unchanged).length,
    unplaceable: report.filter((r) => r.reason === 'UNPLACEABLE').length,
    restday_monday_resolve_left: leftCount,
    away_pending_before: awayCountBefore,
    away_pending_after: (awayAfter || []).length,
    forward_anchor_untouched: faSame,
    rest_days_used: rests.map((r) => r.restDay || r.startDay).filter(Boolean),
    rows: report,
  };
  fs.writeFileSync(
    path.join(root, 'tmp/restday-monday-cleanup-LATEST.json'),
    JSON.stringify(out, null, 2),
  );
  console.log(JSON.stringify(out, null, 2));
}

const habitCacheMiss = new Map();
async function ensureHabit(map, id) {
  if (map.has(id)) return map.get(id);
  if (habitCacheMiss.has(id)) return habitCacheMiss.get(id);
  const rows = await sb(
    `recurring_tasks?id=eq.${id}&select=id,title,duration_min,ideal_time,window_days,time_critical,rrule,priority`,
  );
  const h = rows?.[0] || null;
  if (h) map.set(id, h);
  habitCacheMiss.set(id, h);
  return h;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
