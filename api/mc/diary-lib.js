/**
 * Diary assembly + drop warn-checks.
 * Warn-checks call habit-placer-lib exports (never a flat reimplemented gap).
 */
const { isoToLondonDate, isoToLondonMinutes, ruleMapFromRows, workingWindow, isSchedulableDay, bankHolidaySet } = require('./scheduling-rules-lib');
const { splitMcAndBusy } = require('./rule-breach-lib');
const {
  requiredGapMins, dayCapLimits, awaySpansFromTravelBlocks, dayInsideAwaySpan,
} = require('./habit-placer-lib');
const { isForceBusyCalendar, EXPECTED_CALENDARS } = require('./gcal-lib');

const DAY_START_MIN = 7 * 60;
const DAY_END_MIN = 23 * 60;

const WORKSHOP_CAL = EXPECTED_CALENDARS.find((c) => c.label === 'Workshops')?.id || '';
const LESSON_CAL = EXPECTED_CALENDARS.find((c) => c.label === 'Lessons')?.id || '';

/** Paid Zoom / online 1-2-1 client sessions — purple client booking, always locked. */
function isZoomClientBooking(summary) {
  const t = String(summary || '').toLowerCase();
  const is121 = /1\s*[-–]?\s*2\s*[-–]?\s*1|\b121\b/.test(t);
  if (is121 && /zoom|online|tuition|mentoring|1-2-1/.test(t)) return true;
  if (/\bonline\b/.test(t) && is121) return true;
  if (/\bzoom\b/.test(t) && /(tuition|mentoring|1\s*[-–]?\s*2\s*[-–]?\s*1)/.test(t)) return true;
  return false;
}

function blockTypeFromBusy(ev) {
  const title = ev.summary || ev.title || '';
  // Zoom 1-2-1s win over Lessons/Primary feed — they're fixed client bookings
  if (isZoomClientBooking(title)) return 'workshop';
  const cal = String(ev._calendarId || '');
  if (!cal) return 'personal';
  if (isForceBusyCalendar(cal)) return 'fixture';
  if (WORKSHOP_CAL && cal === WORKSHOP_CAL) return 'workshop';
  if (LESSON_CAL && cal === LESSON_CAL) return 'lesson';
  if (cal.includes('ic364d06')) return 'workshop';
  if (cal.includes('nht93uaq')) return 'lesson';
  return 'personal';
}

function addDaysYmd(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function londonToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

const DONE_STATES = new Set(['done', 'done_claimed', 'verified', 'superseded', 'wont_do']);

function isDoneTask(t) {
  return DONE_STATES.has(t.state) || !!t.completed_on;
}

function toBlock(opts) {
  const start = opts.start;
  const end = opts.end;
  const day = isoToLondonDate(start);
  const sMin = isoToLondonMinutes(start);
  const eMin = isoToLondonMinutes(end);
  return {
    id: opts.id,
    kind: opts.kind,
    title: opts.title,
    day,
    start,
    end,
    start_min: sMin,
    end_min: eMin,
    duration_min: Math.max(0, eMin - sMin),
    editable: !!opts.editable,
    slot_pinned: !!opts.slot_pinned,
    display_id: opts.display_id || null,
    habit_id: opts.habit_id || null,
    ideal_date: opts.ideal_date || null,
    calendar_event_id: opts.calendar_event_id || null,
    read_only: !opts.editable,
    priority: opts.priority || null,
    due_date: opts.due_date || null,
    state: opts.state || null,
    overdue: !!opts.overdue,
    running_late: !!opts.running_late,
    is_buffer: opts.kind === 'buffer',
    client_fixed: !!opts.client_fixed,
  };
}

function tasksToBlocks(tasks, todayYmd) {
  const now = Date.now();
  return (tasks || []).filter((t) => t.scheduled_start && t.scheduled_end).map((t) => {
    const done = isDoneTask(t);
    return toBlock({
      id: `task:${t.id}`,
      kind: 'mc_task',
      title: t.title || `MC-${t.display_id}`,
      start: t.scheduled_start,
      end: t.scheduled_end,
      editable: !done,
      slot_pinned: !!t.slot_pinned,
      display_id: t.display_id,
      calendar_event_id: t.calendar_event_id || null,
      priority: t.priority || null,
      due_date: t.due_date || null,
      state: t.state || null,
      overdue: !done && t.due_date && t.due_date < todayYmd,
      running_late: !done && Date.parse(t.scheduled_start) < now,
    });
  });
}

function travelKind(blockType) {
  if (blockType === 'prep' || blockType === 'decompress') return 'buffer';
  return 'travel';
}

function travelToBlocks(rows) {
  return (rows || []).map((b) => toBlock({
    id: `travel:${b.id}`,
    kind: travelKind(b.block_type),
    title: `${b.block_type}${b.venue_name ? ` · ${b.venue_name}` : ''}`,
    start: b.starts_at,
    end: b.ends_at,
    editable: false,
    calendar_event_id: b.calendar_event_id || null,
  }));
}

function asIso(v) {
  if (!v) return null;
  if (typeof v === 'string' && v.includes('T')) return v;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function busyToBlocks(busy, fixtures) {
  const out = [];
  for (const e of busy || []) {
    const start = e.start?.dateTime || e.start;
    const end = e.end?.dateTime || e.end;
    if (!start || !String(start).includes('T')) continue;
    const kind = blockTypeFromBusy(e);
    const title = e.summary || '(busy)';
    const clientFixed = kind === 'workshop' || isZoomClientBooking(title);
    out.push(toBlock({
      id: `busy:${e.id}`,
      kind,
      title,
      start,
      end,
      editable: false,
      slot_pinned: clientFixed,
      priority: clientFixed ? 'p0' : null,
      client_fixed: clientFixed,
    }));
  }
  for (const e of fixtures || []) {
    out.push(toBlock({
      id: `fix:${e.id}`,
      kind: 'fixture',
      title: e.summary || 'Fixture',
      start: e.start,
      end: e.end,
      editable: false,
    }));
  }
  return out;
}

/**
 * Pre/post match flanks from fixture_blocks (DB). GCal MC ⚽ events are split
 * into `mc` and never painted — this restores the visible Before/After strips.
 */
function fixtureFlanksToBlocks(rows) {
  const out = [];
  for (const r of rows || []) {
    const label = String(r.title || 'Fixture').replace(/^⚽️\s*/, '').trim();
    const fixStart = asIso(r.fixture_start);
    const fixEnd = asIso(r.fixture_end);
    const blockStart = asIso(r.block_start);
    const blockEnd = asIso(r.block_end);
    if (blockStart && fixStart) {
      out.push(toBlock({
        id: `fix-before:${r.fixture_event_id || r.id}`,
        kind: 'buffer',
        title: `pre-match · ${label}`,
        start: blockStart,
        end: fixStart,
        editable: false,
        is_buffer: true,
      }));
    }
    if (fixEnd && blockEnd) {
      out.push(toBlock({
        id: `fix-after:${r.fixture_event_id || r.id}`,
        kind: 'buffer',
        title: `post-match · ${label}`,
        start: fixEnd,
        end: blockEnd,
        editable: false,
        is_buffer: true,
      }));
    }
  }
  return out;
}

/** All-day GCal events (Calendar Dates holidays, birthdays) → day banners. */
function allDayBannersFromBusy(busy) {
  const out = [];
  for (const e of busy || []) {
    const day = e.start?.date ? String(e.start.date).slice(0, 10) : null;
    if (!day) continue;
    out.push({
      day,
      title: e.summary || 'All-day',
      source: 'gcal',
      id: e.id || null,
    });
  }
  return out;
}

function holidayMapFromRows(rows) {
  const map = {};
  for (const r of rows || []) {
    const day = String(r.holiday_date).slice(0, 10);
    map[day] = r.title || 'Bank holiday';
  }
  return map;
}

function habitLogsToBlocks(logs, habitMap) {
  const out = [];
  for (const log of logs || []) {
    const habit = habitMap.get(log.recurring_task_id);
    if (!habit) continue;
    const day = log.scheduled_date;
    if (!day) continue;
    const dur = Number(habit.duration_min || 60);
    const hm = String(habit.ideal_time || '09:00').slice(0, 5);
    const startMs = Date.parse(`${day}T${hm}:00.000Z`);
    const endIso = new Date(startMs + dur * 60000).toISOString();
    out.push(toBlock({
      id: `habit:${habit.id}:${day}`,
      kind: 'habit',
      title: habit.title,
      start: new Date(startMs).toISOString(),
      end: endIso,
      editable: true,
      slot_pinned: false,
      habit_id: habit.id,
      ideal_date: log.ideal_date || day,
      calendar_event_id: log.calendar_event_id || null,
      priority: habit.priority || null,
    }));
  }
  return out;
}

/** Monday-on-or-before (London YMD) — weeks are Mon–Sun. */
function mondayOnOrBefore(ymd) {
  const d = new Date(`${ymd}T12:00:00Z`);
  const dow = d.getUTCDay(); // 0=Sun … 6=Sat
  const back = dow === 0 ? 6 : dow - 1;
  return addDaysYmd(ymd, -back);
}

/**
 * Insert visible decompress strips after appointments (not buffers/fixtures).
 * Uses decompress_after_task_min; skips where an explicit buffer already covers.
 */
function insertDecompressStrips(blocks, ruleMap) {
  const gap = Number(ruleMap.decompress_after_task_min || 30);
  const skipKinds = new Set(['buffer', 'fixture', 'away']);
  const byDay = new Map();
  for (const b of blocks || []) {
    if (!b.day) continue;
    if (!byDay.has(b.day)) byDay.set(b.day, []);
    byDay.get(b.day).push(b);
  }
  const extras = [];
  for (const [day, list] of byDay) {
    const sorted = [...list].sort((a, b) => a.start_min - b.start_min);
    for (let i = 0; i < sorted.length; i += 1) {
      const cur = sorted[i];
      if (skipKinds.has(cur.kind) || cur.is_buffer) continue;
      const stripStart = cur.end_min;
      let stripEnd = stripStart + gap;
      const next = sorted[i + 1];
      if (next && next.start_min < stripEnd) stripEnd = next.start_min;
      if (stripEnd <= stripStart) {
        // Butting edge — still show a thin visual break (8 min ≈ readable)
        stripEnd = stripStart + 8;
      }
      const covered = sorted.some((x) => x.kind === 'buffer'
        && x.start_min <= stripStart && x.end_min >= stripStart + 5);
      if (covered) continue;
      extras.push({
        id: `buffer-gap:${cur.id}:${stripStart}`,
        kind: 'buffer',
        title: 'decompress',
        day,
        start: cur.end,
        end: cur.end,
        start_min: stripStart,
        end_min: stripEnd,
        duration_min: stripEnd - stripStart,
        editable: false,
        read_only: true,
        slot_pinned: false,
        is_buffer: true,
        synthetic: true,
      });
    }
  }
  return [...(blocks || []), ...extras];
}

/** Drop warn-check — uses placer requiredGapMins + dayCapLimits + awaySpans. */
function warnDrop({
  title, day, startMin, endMin, peers, ruleMap, awaySpans, pinned,
}) {
  const warnings = [];
  if (pinned) {
    return {
      ok: false,
      blocked: true,
      warnings: ['Pinned — unlock before dragging'],
      suggest: null,
    };
  }
  if (dayInsideAwaySpan(day, awaySpans)) {
    warnings.push('Away-span day (travel-out → travel-back inclusive)');
  }
  const { target, hard } = dayCapLimits(ruleMap);
  const used = peers.filter((p) => p.day === day)
    .reduce((s, p) => s + Math.max(0, (p.end_min || 0) - (p.start_min || 0)), 0);
  const add = Math.max(0, endMin - startMin);
  if (used + add > target) warnings.push(`Over ${target}-min daily cap (would be ${used + add}m)`);
  if (used + add > hard) warnings.push(`Over hard cap ${hard}m`);

  const sameDay = peers
    .filter((p) => p.day === day)
    .sort((a, b) => a.start_min - b.start_min);
  for (const p of sameDay) {
    if (startMin < p.end_min && p.start_min < endMin) {
      warnings.push(`Overlap with "${p.title}"`);
    }
    const gapAfter = startMin - p.end_min;
    if (gapAfter >= 0 && gapAfter < 24 * 60) {
      const need = requiredGapMins(p.title, title, ruleMap);
      if (gapAfter < need) {
        warnings.push(`Decompress buffer: ${gapAfter}m < ${need}m after "${p.title}" (placer requiredGapMins)`);
      }
    }
    const gapBefore = p.start_min - endMin;
    if (gapBefore >= 0 && gapBefore < 24 * 60) {
      const need = requiredGapMins(title, p.title, ruleMap);
      if (gapBefore < need) {
        warnings.push(`Decompress buffer: ${gapBefore}m < ${need}m before "${p.title}" (placer requiredGapMins)`);
      }
    }
  }

  let suggest = null;
  if (warnings.length) {
    const winEnd = Number(String(ruleMap.working_day_end || '18:00').slice(0, 2)) * 60 || 18 * 60;
    suggest = { day, start_min: Math.min(startMin, winEnd - add), note: 'Override allowed — Alan disposes' };
  }
  return { ok: warnings.length === 0, blocked: false, warnings, suggest };
}

/** fromYmd must be a Monday; each week is Mon–Sun. */
function weeksFrom(fromYmd, weekCount) {
  const weeks = [];
  let cur = mondayOnOrBefore(fromYmd);
  for (let w = 0; w < weekCount; w += 1) {
    const days = [];
    for (let d = 0; d < 7; d += 1) days.push(addDaysYmd(cur, d));
    weeks.push({ week_index: w, days });
    cur = addDaysYmd(cur, 7);
  }
  return weeks;
}

/**
 * Week fuel gauge: filled minutes inside working windows / available working minutes.
 * Away days contribute 0 available. Buffers/synthetic strips excluded from filled.
 */
function weekCapacity(days, blocks, awayDays, ruleMap, holidays) {
  let available = 0;
  let filled = 0;
  const daySet = new Set(days || []);
  for (const day of days || []) {
    if (awayDays?.[day]) continue;
    if (!isSchedulableDay(day, ruleMap, holidays)) continue;
    const win = workingWindow(ruleMap, day);
    const a0 = win.start_min ?? 0;
    const a1 = win.end_min ?? 0;
    const avail = Math.max(0, a1 - a0);
    available += avail;
    for (const b of blocks || []) {
      if (b.day !== day || b.is_buffer || b.synthetic || b.kind === 'buffer') continue;
      const start = Math.max(b.start_min || 0, a0);
      const end = Math.min(b.end_min || 0, a1);
      if (end > start) filled += end - start;
    }
  }
  const pct = available > 0 ? Math.round((filled / available) * 100) : (filled > 0 ? 100 : 0);
  return {
    available_min: available,
    filled_min: filled,
    free_min: Math.max(0, available - filled),
    pct: Math.min(pct, 999),
    over: filled > available,
    label: `${Math.min(pct, 999)}% · ${Math.round(filled / 60 * 10) / 10}h / ${Math.round(available / 60 * 10) / 10}h`,
  };
}

function attachWeekCapacity(weeks, blocks, awayDays, ruleMap) {
  const fromY = (weeks?.[0]?.days?.[0] || '').slice(0, 4);
  const toY = (weeks?.[weeks.length - 1]?.days?.[6] || fromY).slice(0, 4);
  const holidays = bankHolidaySet(Number(fromY) || 2026, Number(toY) || 2026);
  return (weeks || []).map((w) => ({
    ...w,
    capacity: weekCapacity(w.days, blocks, awayDays, ruleMap, holidays),
  }));
}

module.exports = {
  DAY_START_MIN,
  DAY_END_MIN,
  addDaysYmd,
  londonToday,
  mondayOnOrBefore,
  ruleMapFromRows,
  splitMcAndBusy,
  awaySpansFromTravelBlocks,
  tasksToBlocks,
  travelToBlocks,
  busyToBlocks,
  fixtureFlanksToBlocks,
  allDayBannersFromBusy,
  holidayMapFromRows,
  habitLogsToBlocks,
  insertDecompressStrips,
  warnDrop,
  weeksFrom,
  weekCapacity,
  attachWeekCapacity,
  isZoomClientBooking,
  blockTypeFromBusy,
};
