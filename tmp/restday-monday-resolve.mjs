/**
 * Targeted re-solve: move habits off Sunday-return recovery Mondays to nearest
 * earlier legal slot. DB + gcal_push_queue only — no calendar writes.
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
  isoToLondonMinutes,
} = require('../api/mc/scheduling-rules-lib.js');
const {
  awaySpansFromTravelBlocks, teachingDaySpansFromEvents, dayBlockedForPlacement,
  buildBusyIntervals, datedTasksToIntervals, trySlotOnDay, londonYmdHmToUtcMs,
  dayCapLimits,
} = require('../api/mc/habit-placer-lib.js');
const { relatedIdForHabit, upsertPushRow } = require('../api/mc/gcal-push-lib.js');
const { gcalConfigured, fetchHorizonEvents } = require('../api/mc/gcal-lib.js');

const REST_MONDAYS = [
  '2026-08-17', '2026-09-14', '2026-09-21', '2026-09-28', '2026-10-05',
  '2026-10-26', '2026-11-02', '2026-11-16', '2026-11-23',
];
const REST_SET = new Set(REST_MONDAYS);
const LOOKBACK_DAYS = 60;

function overlaps(a0, a1, b0, b1) {
  return a0 < b1 && b0 < a1;
}

async function main() {
  const dry = process.argv.includes('--dry');
  const rulesRows = await sb('scheduling_rules?select=key,value');
  const ruleMap = ruleMapFromRows(rulesRows);
  const holidays = bankHolidaySet(2026, 2027);
  const { hard: hardCap } = dayCapLimits(ruleMap);

  // Lookback needs room before first rest Monday (17 Aug)
  const from = '2026-07-01';
  const to = '2026-12-01';
  const travel = await sb(
    'travel_blocks?select=block_type,starts_at,ends_at,venue_name,workshop_title,workshop_start,workshop_row_key'
    + '&block_type=in.(travel_out,travel_back)'
    + `&starts_at=gte.${from}T00:00:00Z&starts_at=lte.${to}T23:59:59Z`,
  );
  const awaySpans = awaySpansFromTravelBlocks(travel || [], ruleMap);

  if (!gcalConfigured()) throw new Error('GCAL required for busy map');
  const { events } = await fetchHorizonEvents(
    `${from}T00:00:00.000Z`,
    `${to}T23:59:59.000Z`,
  );
  const teaching = teachingDaySpansFromEvents(events || []);
  const blockedSpans = awaySpans.concat(teaching);

  const tasks = await sb(
    'tasks?select=display_id,title,state,slot_pinned,scheduled_start,scheduled_end,calendar_event_id'
    + `&scheduled_start=gte.${from}T00:00:00Z&scheduled_start=lte.${to}T23:59:59Z`
    + '&state=not.in.(done,verified,wont_do,superseded)',
  );
  const pinnedBusy = datedTasksToIntervals(tasks || [], { pinnedOnly: true });
  const softBusy = datedTasksToIntervals(tasks || [], { pinnedOnly: false });
  let busy = buildBusyIntervals(events || [], ruleMap)
    .concat(pinnedBusy)
    .concat(softBusy)
    .concat(blockedSpans)
    .sort((a, b) => a.startMs - b.startMs);

  const habits = await sb(
    'recurring_tasks?select=id,title,duration_min,ideal_time,priority,active&active=eq.true',
  );
  const habitById = new Map((habits || []).map((h) => [h.id, h]));

  const mondayFilter = REST_MONDAYS.map((d) => `"${d}"`).join(',');
  const logs = await sb(
    `recurring_log?scheduled_date=in.(${mondayFilter})&select=id,recurring_task_id,ideal_date,scheduled_date,calendar_event_id,change,at`
    + '&order=scheduled_date.asc',
  );
  const targets = (logs || []).filter((r) => {
    const c = String(r.change || '');
    return !/^skipped/i.test(c) && !/^completed/i.test(c);
  });

  // Existing habit placements as placed blocks (for decompress), excluding targets we'll move
  const targetIds = new Set(targets.map((t) => t.id));
  const allLogs = await sb(
    `recurring_log?scheduled_date=gte.${from}&scheduled_date=lte.${to}`
    + '&select=id,recurring_task_id,ideal_date,scheduled_date,calendar_event_id,change&order=scheduled_date.asc&limit=5000',
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
    // Also treat as busy so we don't land on them
    busy.push({ startMs: Date.parse(startIso), endMs: Date.parse(endIso), summary: habit.title });
  }
  busy.sort((a, b) => a.startMs - b.startMs);

  // Drop target calendar events from busy so we can leave the Monday
  const targetEventIds = new Set(targets.map((t) => t.calendar_event_id).filter(Boolean));
  busy = busy.filter((b) => {
    // can't filter by event id on intervals — strip by matching start day on Monday + title later
    return true;
  });

  const moves = [];
  const unplaced = [];

  // Process later Mondays first so Nov 23 congestion resolves with more earlier room? Actually earlier first is safer for "nearest earlier". Sort by scheduled_date ASC then title.
  targets.sort((a, b) => String(a.scheduled_date).localeCompare(b.scheduled_date)
    || String(habitById.get(a.recurring_task_id)?.title || '').localeCompare(
      String(habitById.get(b.recurring_task_id)?.title || ''),
    ));

  for (const row of targets) {
    const habit = habitById.get(row.recurring_task_id);
    if (!habit) {
      unplaced.push({ ...row, reason: 'habit missing' });
      continue;
    }
    const monday = row.scheduled_date;
    const durationMin = Number(habit.duration_min) || 60;
    const idealHm = String(habit.ideal_time || '09:00').slice(0, 5);

    // Remove this occurrence from busy if we can match by calendar day+duration from old pin/ideal
    // (best-effort: strip busy intervals that fall entirely on monday for this habit title)
    busy = busy.filter((b) => {
      const d = isoToLondonDate(new Date(b.startMs).toISOString());
      if (d !== monday) return true;
      return b.summary !== habit.title && !String(b.summary || '').includes(habit.title.slice(0, 20));
    });

    let slot = null;
    for (let i = 1; i <= LOOKBACK_DAYS; i += 1) {
      const day = addDays(monday, -i);
      if (day < from) break;
      if (REST_SET.has(day)) continue; // never land on another clear-Monday
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
        monday,
        title: habit.title,
        habit_id: habit.id,
        log_id: row.id,
        reason: `no earlier legal slot within ${LOOKBACK_DAYS} days`,
      });
      continue;
    }

    const related = relatedIdForHabit(habit.id, row.ideal_date || monday, row.calendar_event_id);
    const pinChange = `diary_pin:${slot.startIso}|${slot.endIso}`;
    const move = {
      log_id: row.id,
      habit_id: habit.id,
      title: habit.title,
      from_monday: monday,
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

    // Occupy slot for subsequent placements
    placed.push({
      day: slot.day,
      startIso: slot.startIso,
      endIso: slot.endIso,
      title: habit.title,
      duration_min: durationMin,
    });
    dayUsed[slot.day] = (dayUsed[slot.day] || 0) + durationMin;
    busy.push({
      startMs: Date.parse(slot.startIso),
      endMs: Date.parse(slot.endIso),
      summary: habit.title,
    });
    busy.sort((a, b) => a.startMs - b.startMs);
  }

  // Assertions per Monday
  const assertions = {};
  for (const mon of REST_MONDAYS) {
    const still = moves.filter((m) => m.from_monday === mon).length;
    const failed = unplaced.filter((u) => u.monday === mon);
    const landed = moves.filter((m) => m.from_monday === mon);
    // Cap / overlap check on destination days
    const destDays = [...new Set(landed.map((m) => m.to_day))];
    const destIssues = [];
    const newTitles = new Set(landed.map((m) => m.title));
    for (const day of destDays) {
      if (REST_SET.has(day)) destIssues.push(`landed_on_rest_monday ${day}`);
      const onDay = placed.filter((p) => p.day === day);
      const mins = onDay.reduce((s, p) => s + (p.duration_min || 0), 0);
      if (mins > hardCap) destIssues.push(`cap ${day}: ${mins}m > ${hardCap}m`);
      const newcomers = onDay.filter((p) => newTitles.has(p.title)
        && landed.some((m) => m.to_day === day && m.title === p.title
          && m.new_start === p.startIso));
      for (const a of newcomers) {
        for (const b of onDay) {
          if (a === b) continue;
          if (overlaps(Date.parse(a.startIso), Date.parse(a.endIso), Date.parse(b.startIso), Date.parse(b.endIso))) {
            destIssues.push(`overlap ${day}: ${a.title} × ${b.title}`);
          }
        }
      }
    }
    assertions[mon] = {
      cleared_planned: failed.length === 0 && landed.every((m) => !REST_SET.has(m.to_day)),
      move_count: landed.length,
      unplaced: failed,
      dest_issues: destIssues,
      landings: landed.map((m) => ({
        title: m.title,
        to_day: m.to_day,
        start: m.new_start,
        end: m.new_end,
        related_id: m.related_id,
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
          roll_reason: 'restday_monday_resolve',
          calendar_event_id: m.calendar_event_id || null,
          projection_key: `restday:${m.habit_id}:${m.ideal_date || m.from_monday}`,
        },
      });
      await upsertPushRow(sb, {
        related_id: m.related_id,
        entity_type: 'habit',
        change_kind: 'move',
        summary: `Rest-Monday clear: ${m.title} ${m.from_monday} → ${m.to_day}`,
        proposed_action: [
          `MOVE habit "${m.title}" from ${m.from_monday} to ${m.new_start}–${m.new_end}.`,
          m.calendar_event_id ? `event_id=${m.calendar_event_id}` : 'create if missing',
          'Reason: Sunday-return recovery Monday (rest_day_after_sunday_return).',
        ].join(' '),
        payload: {
          habit_id: m.habit_id,
          title: m.title,
          ideal_date: m.ideal_date,
          from_monday: m.from_monday,
          new_start: m.new_start,
          new_end: m.new_end,
          calendar_event_id: m.calendar_event_id || null,
          reason: 'rest_day_after_sunday_return',
        },
      });
    }
  }

  // Verify DB Mondays clear after apply
  let verify = null;
  if (!dry) {
    const left = await sb(
      `recurring_log?scheduled_date=in.(${mondayFilter})&select=id,scheduled_date,recurring_task_id,change`,
    );
    verify = (left || []).filter((r) => {
      const c = String(r.change || '');
      return !/^skipped/i.test(c) && !/^completed/i.test(c);
    });
  }

  const out = {
    dry,
    rule: 'rest_day_after_sunday_return',
    targets: targets.length,
    moves: moves.length,
    unplaced: unplaced.length,
    related_ids: moves.map((m) => m.related_id),
    assertions,
    nov23: assertions['2026-11-23'],
    verify_remaining_on_mondays: verify,
    move_rows: moves,
    unplaced_rows: unplaced,
  };

  const outPath = path.join(root, 'tmp/restday-monday-resolve-LATEST.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({
    dry,
    moves: moves.length,
    unplaced: unplaced.length,
    related_ids: out.related_ids,
    nov23_landings: out.nov23?.landings,
    verify_remaining: verify?.length ?? null,
    outPath,
  }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
