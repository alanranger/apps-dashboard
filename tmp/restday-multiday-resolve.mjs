/**
 * Correct rest days from multi-day workshop events; move habits off them.
 * DB + gcal_push_queue only — no calendar writes.
 * Usage: node tmp/restday-multiday-resolve.mjs [--dry]
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
const {
  addDays, ruleMapFromRows, bankHolidaySet, isSchedulableDay, isoToLondonDate,
} = require('../api/mc/scheduling-rules-lib.js');
const {
  awaySpansFromTravelBlocks, teachingDaySpansFromEvents, restDaySpansFromWorkshopEvents,
  multidayWorkshopRestRows, buildBusyIntervals, datedTasksToIntervals, trySlotOnDay,
  londonYmdHmToUtcMs, dayCapLimits, dayBlockedForPlacement,
} = require('../api/mc/habit-placer-lib.js');
const { relatedIdForHabit, upsertPushRow } = require('../api/mc/gcal-push-lib.js');
const { gcalConfigured, fetchHorizonEvents } = require('../api/mc/gcal-lib.js');

const LOOKBACK_DAYS = 60;
const FROM = '2026-07-01';
const TO = '2027-07-31';

function overlaps(a0, a1, b0, b1) {
  return a0 < b1 && b0 < a1;
}

async function main() {
  const dry = process.argv.includes('--dry');
  const rulesRows = await sb('scheduling_rules?select=key,value');
  const ruleMap = ruleMapFromRows(rulesRows);
  const holidays = bankHolidaySet(2026, 2027);
  const { hard: hardCap } = dayCapLimits(ruleMap);

  if (!gcalConfigured()) throw new Error('GCAL required');
  const { events } = await fetchHorizonEvents(`${FROM}T00:00:00.000Z`, `${TO}T23:59:59.000Z`);
  const workshopRows = multidayWorkshopRestRows(events || []);
  const restSpans = restDaySpansFromWorkshopEvents(events || [], ruleMap);
  const restDays = [...new Set(restSpans.map((s) => s.restDay))].sort();
  const restSet = new Set(restDays);

  const travel = await sb(
    'travel_blocks?select=block_type,starts_at,ends_at,venue_name,workshop_title,workshop_start,workshop_row_key'
    + '&block_type=in.(travel_out,travel_back)'
    + `&starts_at=gte.${FROM}T00:00:00Z&starts_at=lte.${TO}T23:59:59Z`,
  );
  const awaySpans = awaySpansFromTravelBlocks(travel || []);
  const teaching = teachingDaySpansFromEvents(events || []);
  const blockedSpans = awaySpans.concat(teaching).concat(restSpans);

  const tasks = await sb(
    'tasks?select=display_id,title,state,slot_pinned,scheduled_start,scheduled_end,calendar_event_id'
    + `&scheduled_start=gte.${FROM}T00:00:00Z&scheduled_start=lte.${TO}T23:59:59Z`
    + '&state=not.in.(done,verified,wont_do,superseded)',
  );
  const pinnedBusy = datedTasksToIntervals(tasks || [], { pinnedOnly: true });
  const softBusy = datedTasksToIntervals(tasks || [], { pinnedOnly: false });
  let busy = buildBusyIntervals(events || [], ruleMap)
    .concat(pinnedBusy).concat(softBusy).concat(blockedSpans)
    .sort((a, b) => a.startMs - b.startMs);

  const habits = await sb(
    'recurring_tasks?select=id,title,duration_min,ideal_time,priority,active&active=eq.true',
  );
  const habitById = new Map((habits || []).map((h) => [h.id, h]));

  const tasksOnRest = (tasks || []).filter((t) => {
    const d = isoToLondonDate(t.scheduled_start);
    return d && restSet.has(d);
  }).map((t) => ({
    display_id: t.display_id, title: t.title, day: isoToLondonDate(t.scheduled_start),
  }));

  if (!restDays.length) {
    const out = { dry, workshopRows, restDays: [], moves: 0, note: 'no multi-day rest days' };
    fs.writeFileSync(path.join(root, 'tmp/restday-multiday-resolve-LATEST.json'), JSON.stringify(out, null, 2));
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  const dayFilter = restDays.map((d) => `"${d}"`).join(',');
  const logs = await sb(
    `recurring_log?scheduled_date=in.(${dayFilter})&select=id,recurring_task_id,ideal_date,scheduled_date,calendar_event_id,change,at`
    + '&order=scheduled_date.asc',
  );
  const targets = (logs || []).filter((r) => {
    const c = String(r.change || '');
    return !/^skipped/i.test(c) && !/^completed/i.test(c);
  });

  const targetIds = new Set(targets.map((t) => t.id));
  const allLogs = await sb(
    `recurring_log?scheduled_date=gte.${FROM}&scheduled_date=lte.${TO}`
    + '&select=id,recurring_task_id,ideal_date,scheduled_date,calendar_event_id,change&order=scheduled_date.asc&limit=8000',
  );
  const placed = [];
  const dayUsed = {};
  for (const log of allLogs || []) {
    if (targetIds.has(log.id)) continue;
    const c = String(log.change || '');
    if (/^skipped/i.test(c) || /^completed/i.test(c)) continue;
    const habit = habitById.get(log.recurring_task_id);
    if (!habit) continue;
    const day = log.scheduled_date;
    const dur = Number(habit.duration_min) || 60;
    const pin = /^diary_pin:(.+)\|(.+)$/.exec(c);
    let startIso;
    let endIso;
    if (pin) {
      startIso = pin[1];
      endIso = pin[2];
    } else {
      const hm = String(habit.ideal_time || '09:00').slice(0, 5);
      const startMs = londonYmdHmToUtcMs(day, hm);
      startIso = new Date(startMs).toISOString();
      endIso = new Date(startMs + dur * 60000).toISOString();
    }
    const durationMin = Math.max(15, Math.round((Date.parse(endIso) - Date.parse(startIso)) / 60000));
    placed.push({ day, startIso, endIso, title: habit.title, duration_min: durationMin });
    dayUsed[day] = (dayUsed[day] || 0) + durationMin;
    busy.push({ startMs: Date.parse(startIso), endMs: Date.parse(endIso), summary: habit.title });
  }
  busy.sort((a, b) => a.startMs - b.startMs);

  targets.sort((a, b) => String(a.scheduled_date).localeCompare(b.scheduled_date)
    || String(habitById.get(a.recurring_task_id)?.title || '').localeCompare(
      String(habitById.get(b.recurring_task_id)?.title || ''),
    ));

  const moves = [];
  const unplaced = [];

  for (const row of targets) {
    const habit = habitById.get(row.recurring_task_id);
    if (!habit) {
      unplaced.push({ ...row, reason: 'habit missing' });
      continue;
    }
    const fromDay = row.scheduled_date;
    const durationMin = Number(habit.duration_min) || 60;
    const idealHm = String(habit.ideal_time || '09:00').slice(0, 5);

    busy = busy.filter((b) => {
      const d = isoToLondonDate(new Date(b.startMs).toISOString());
      if (d !== fromDay) return true;
      return b.summary !== habit.title && !String(b.summary || '').includes(habit.title.slice(0, 20));
    });

    let slot = null;
    for (let i = 1; i <= LOOKBACK_DAYS; i += 1) {
      const day = addDays(fromDay, -i);
      if (day < FROM) break;
      if (restSet.has(day)) continue;
      if (!isSchedulableDay(day, ruleMap, holidays)) continue;
      if (dayBlockedForPlacement(day, blockedSpans)) continue;
      const trial = trySlotOnDay(
        day, durationMin, idealHm, habit.title, busy, placed, dayUsed, ruleMap,
      );
      if (trial) {
        slot = trial;
        break;
      }
    }

    if (!slot) {
      unplaced.push({
        rest_day: fromDay,
        title: habit.title,
        habit_id: habit.id,
        log_id: row.id,
        reason: `no earlier legal slot within ${LOOKBACK_DAYS} days`,
      });
      continue;
    }

    const related = relatedIdForHabit(habit.id, row.ideal_date || fromDay, row.calendar_event_id);
    const pinChange = `diary_pin:${slot.startIso}|${slot.endIso}`;
    const move = {
      log_id: row.id,
      habit_id: habit.id,
      title: habit.title,
      from_rest_day: fromDay,
      ideal_date: row.ideal_date,
      calendar_event_id: row.calendar_event_id,
      to_day: slot.day,
      new_start: slot.startIso,
      new_end: slot.endIso,
      duration_min: durationMin,
      related_id: related,
      pinChange,
    };
    moves.push(move);
    placed.push({
      day: slot.day, startIso: slot.startIso, endIso: slot.endIso,
      title: habit.title, duration_min: durationMin,
    });
    dayUsed[slot.day] = (dayUsed[slot.day] || 0) + durationMin;
    busy.push({
      startMs: Date.parse(slot.startIso), endMs: Date.parse(slot.endIso), summary: habit.title,
    });
    busy.sort((a, b) => a.startMs - b.startMs);
  }

  const assertions = {};
  for (const day of restDays) {
    const landed = moves.filter((m) => m.from_rest_day === day);
    const failed = unplaced.filter((u) => u.rest_day === day);
    const destIssues = [];
    for (const m of landed) {
      if (restSet.has(m.to_day)) destIssues.push(`landed_on_rest ${m.to_day}`);
      const onDay = placed.filter((p) => p.day === m.to_day);
      const mins = onDay.reduce((s, p) => s + (p.duration_min || 0), 0);
      if (mins > hardCap) destIssues.push(`cap ${m.to_day}: ${mins}m > ${hardCap}m`);
      for (const b of onDay) {
        if (b.title === m.title && b.startIso === m.new_start) continue;
        if (overlaps(Date.parse(m.new_start), Date.parse(m.new_end), Date.parse(b.startIso), Date.parse(b.endIso))) {
          destIssues.push(`overlap ${m.to_day}: ${m.title} × ${b.title}`);
        }
      }
    }
    assertions[day] = {
      cleared_planned: failed.length === 0,
      move_count: landed.length,
      unplaced: failed,
      dest_issues: [...new Set(destIssues)],
      landings: landed.map((m) => ({
        title: m.title, to_day: m.to_day, start: m.new_start, end: m.new_end, related_id: m.related_id,
      })),
    };
  }

  if (!dry) {
    for (const m of moves) {
      await sb(`recurring_log?id=eq.${m.log_id}`, {
        method: 'PATCH',
        prefer: 'return=minimal',
        body: {
          change: m.pinChange,
          scheduled_date: m.to_day,
          roll_reason: 'restday_multiday_workshop_resolve',
          calendar_event_id: m.calendar_event_id || null,
          projection_key: `restday_ws:${m.habit_id}:${m.ideal_date || m.from_rest_day}`,
        },
      });
      await upsertPushRow(sb, {
        related_id: m.related_id,
        entity_type: 'habit',
        change_kind: 'move',
        summary: `Rest-day clear: ${m.title} ${m.from_rest_day} → ${m.to_day}`,
        proposed_action: [
          `MOVE habit "${m.title}" from ${m.from_rest_day} to ${m.new_start}–${m.new_end}.`,
          m.calendar_event_id ? `event_id=${m.calendar_event_id}` : 'create if missing',
          'Reason: rest day after multi-day workshop (rest_day_after_multiday_workshop).',
        ].join(' '),
        payload: {
          habit_id: m.habit_id,
          title: m.title,
          ideal_date: m.ideal_date,
          from_rest_day: m.from_rest_day,
          new_start: m.new_start,
          new_end: m.new_end,
          calendar_event_id: m.calendar_event_id || null,
          reason: 'rest_day_after_multiday_workshop',
        },
      });
    }
    for (const t of tasksOnRest) {
      await upsertPushRow(sb, {
        related_id: `gcal:task:MC-${t.display_id}:rest:${t.day}`,
        entity_type: 'task',
        change_kind: 'move',
        summary: `Rest-day flag: MC-${t.display_id} on ${t.day}`,
        proposed_action: [
          `MOVE task MC-${t.display_id} ("${t.title}") off rest day ${t.day}`,
          '(day after multi-day workshop). Pick nearest earlier legal desk slot.',
        ].join(' '),
        payload: {
          display_id: t.display_id,
          title: t.title,
          from_rest_day: t.day,
          reason: 'rest_day_after_multiday_workshop',
        },
      });
    }
  }

  let verify = null;
  if (!dry) {
    const left = await sb(
      `recurring_log?scheduled_date=in.(${dayFilter})&select=id,scheduled_date,recurring_task_id,change`,
    );
    verify = (left || []).filter((r) => {
      const c = String(r.change || '');
      return !/^skipped/i.test(c) && !/^completed/i.test(c);
    });
  }

  const wrongExamples = {
    '2026-08-24': 'must NOT be rest (single-day Abstract & Macro Sun 23 Aug)',
    '2026-10-19': 'check — only rest if a multi-day workshop ended 18 Oct',
    '2027-01-12': 'check — only rest if a multi-day workshop ended 11 Jan 2027',
  };
  const wrongCheck = {};
  for (const [d, note] of Object.entries(wrongExamples)) {
    wrongCheck[d] = { is_rest: restSet.has(d), note };
  }

  const out = {
    dry,
    rule: 'rest_day_after_multiday_workshop',
    workshop_multiday: workshopRows,
    rest_days: restDays,
    wrong_rule_examples_check: wrongCheck,
    tasks_on_rest: tasksOnRest,
    targets: targets.length,
    moves: moves.length,
    unplaced: unplaced.length,
    related_ids: moves.map((m) => m.related_id),
    assertions,
    verify_remaining_on_rest_days: verify,
    move_rows: moves,
    unplaced_rows: unplaced,
  };

  const outPath = path.join(root, 'tmp/restday-multiday-resolve-LATEST.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({
    dry,
    multiday_workshops: workshopRows.length,
    rest_days: restDays,
    wrongCheck,
    moves: moves.length,
    unplaced: unplaced.length,
    tasks_on_rest: tasksOnRest.length,
    verify_remaining: verify?.length ?? null,
    outPath,
  }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
