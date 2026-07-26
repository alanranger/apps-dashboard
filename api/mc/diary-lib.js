/**
 * Diary assembly + drop warn-checks.
 * Warn-checks call habit-placer-lib exports (never a flat reimplemented gap).
 */
const { isoToLondonDate, isoToLondonMinutes, ruleMapFromRows, workingWindow, isSchedulableDay, bankHolidaySet } = require('./scheduling-rules-lib');
const { splitMcAndBusy } = require('./rule-breach-lib');
const {
  requiredGapMins, dayCapLimits, awaySpansFromTravelBlocks, dayInsideAwaySpan,
  londonYmdHmToUtcMs,
} = require('./habit-placer-lib');
const { isForceBusyCalendar, EXPECTED_CALENDARS } = require('./gcal-lib');

const DAY_START_MIN = 7 * 60;
const DAY_END_MIN = 23 * 60;
const AXIS_STEP_MIN = 30;
const PX_PER_STEP = 36;
const GRID_PX = ((DAY_END_MIN - DAY_START_MIN) / AXIS_STEP_MIN) * PX_PER_STEP;

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
    done: !!opts.done,
    actual_minutes: opts.actual_minutes != null ? Number(opts.actual_minutes) : null,
  };
}

function tasksToBlocks(tasks, todayYmd) {
  const now = Date.now();
  return (tasks || []).filter((t) => t.scheduled_start && t.scheduled_end).map((t) => {
    const done = isDoneTask(t);
    let end = t.scheduled_end;
    if (done && t.actual_minutes && t.scheduled_start) {
      const startMs = Date.parse(t.scheduled_start);
      if (Number.isFinite(startMs)) {
        end = new Date(startMs + Number(t.actual_minutes) * 60000).toISOString();
      }
    }
    return toBlock({
      id: `task:${t.id}`,
      kind: 'mc_task',
      title: t.title || `MC-${t.display_id}`,
      start: t.scheduled_start,
      end,
      editable: !done,
      slot_pinned: !!t.slot_pinned,
      display_id: t.display_id,
      calendar_event_id: t.calendar_event_id || null,
      priority: t.priority || null,
      due_date: t.due_date || null,
      state: t.state || null,
      overdue: !done && t.due_date && t.due_date < todayYmd,
      running_late: !done && Date.parse(t.scheduled_start) < now,
      done,
      actual_minutes: t.actual_minutes != null ? t.actual_minutes : null,
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

function parseDiaryPin(change) {
  const m = String(change || '').match(/^diary_pin:([^|]+)\|(.+)$/);
  if (!m) return null;
  return { start: m[1].trim(), end: m[2].trim() };
}

function parseCompleteMeta(change) {
  const m = String(change || '').match(/^completed\s+(\d{4}-\d{2}-\d{2})(?:\|actual=(\d+))?/i);
  if (!m) return null;
  return { date: m[1], actual_min: m[2] != null ? Number(m[2]) : null };
}

function isSkippedChange(change) {
  return /^skipped\b/i.test(String(change || ''));
}

function habitLogsToBlocks(logs, habitMap) {
  const best = new Map();
  for (const log of logs || []) {
    if (!log.scheduled_date || !log.recurring_task_id) continue;
    if (isSkippedChange(log.change)) continue; // this occurrence removed from schedule
    const key = `${log.recurring_task_id}:${log.scheduled_date}`;
    const prev = best.get(key);
    if (!prev) {
      best.set(key, log);
      continue;
    }
    const prevPin = !!parseDiaryPin(prev.change);
    const curPin = !!parseDiaryPin(log.change);
    const prevDone = !!parseCompleteMeta(prev.change);
    const curDone = !!parseCompleteMeta(log.change);
    if (curDone && !prevDone) best.set(key, log);
    else if (curPin && !prevPin && !prevDone) best.set(key, log);
    else if (String(log.at || '') > String(prev.at || '')) best.set(key, log);
  }
  const out = [];
  for (const log of best.values()) {
    const habit = habitMap.get(log.recurring_task_id);
    if (!habit) continue;
    const day = log.scheduled_date;
    const ideal = log.ideal_date || day;
    const doneMeta = parseCompleteMeta(log.change);
    const done = !!(doneMeta || (habit.last_done && String(habit.last_done) >= String(ideal)));
    const durPlan = Number(habit.duration_min || 60);
    const actual = doneMeta?.actual_min != null ? doneMeta.actual_min : null;
    const dur = actual != null ? actual : durPlan;
    const pin = parseDiaryPin(log.change);
    let startIso;
    let endIso;
    if (pin?.start && pin?.end && !done) {
      startIso = pin.start;
      endIso = pin.end;
    } else if (pin?.start && done) {
      startIso = pin.start;
      endIso = new Date(Date.parse(pin.start) + dur * 60000).toISOString();
    } else {
      const hm = String(habit.ideal_time || '09:00').slice(0, 5);
      const startMs = londonYmdHmToUtcMs(day, hm);
      startIso = new Date(startMs).toISOString();
      endIso = new Date(startMs + dur * 60000).toISOString();
    }
    out.push(toBlock({
      id: `habit:${habit.id}:${day}`,
      kind: 'habit',
      title: habit.title,
      start: startIso,
      end: endIso,
      editable: !done,
      slot_pinned: false,
      habit_id: habit.id,
      ideal_date: ideal,
      calendar_event_id: log.calendar_event_id || null,
      priority: habit.priority || null,
      done,
      actual_minutes: actual,
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
 * Merge [start,end] minute intervals (overlap → one span).
 */
function mergeIntervals(intervals) {
  if (!intervals.length) return [];
  const sorted = intervals.map((x) => [x[0], x[1]]).sort((a, b) => a[0] - b[0]);
  const out = [sorted[0]];
  for (let i = 1; i < sorted.length; i += 1) {
    const last = out[out.length - 1];
    const cur = sorted[i];
    if (cur[0] <= last[1]) last[1] = Math.max(last[1], cur[1]);
    else out.push(cur);
  }
  return out;
}

/**
 * Week fuel = real load vs YOUR working windows (scheduling_rules), not the
 * diary display axis. Available = weekday 10–17 / weekend 11–16 (from rules).
 * Away/bank-holiday = that day's whole window filled. Other days = merged
 * travel/workshop/habit/task/personal/buffer clipped to the window; load
 * outside the window still counts (pct can exceed 100% = overrun).
 */
function weekCapacity(days, blocks, awayDays, ruleMap, holidays) {
  let available = 0;
  let filled = 0;
  let awayDaysCounted = 0;
  for (const day of days || []) {
    const win = workingWindow(ruleMap || {}, day);
    const w0 = win.start_min ?? 10 * 60;
    const w1 = win.end_min ?? 17 * 60;
    const dayAvail = Math.max(0, w1 - w0);
    available += dayAvail;

    const away = !!(awayDays?.[day] || (holidays && holidays.has(day)));
    if (away) {
      filled += dayAvail;
      awayDaysCounted += 1;
      continue;
    }

    const intervals = [];
    for (const b of blocks || []) {
      if (b.day !== day || b.synthetic) continue;
      const start = b.start_min || 0;
      const end = b.end_min || 0;
      if (end > start) intervals.push([start, end]);
    }
    // Inside-window load (capacity used) + outside-window overtime
    let inside = 0;
    let outside = 0;
    for (const [s, e] of mergeIntervals(intervals)) {
      const inS = Math.max(s, w0);
      const inE = Math.min(e, w1);
      if (inE > inS) inside += (inE - inS);
      if (s < w0) outside += Math.min(e, w0) - s;
      if (e > w1) outside += e - Math.max(s, w1);
    }
    filled += inside + outside;
  }
  const pct = available > 0 ? Math.round((filled / available) * 100) : (filled > 0 ? 100 : 0);
  const filledH = Math.round((filled / 60) * 10) / 10;
  const availH = Math.round((available / 60) * 10) / 10;
  return {
    available_min: available,
    filled_min: filled,
    free_min: Math.max(0, available - filled),
    pct: Math.min(pct, 999),
    over: filled > available,
    away_days: awayDaysCounted,
    label: `${Math.min(pct, 999)}% · ${filledH}h / ${availH}h`,
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
  AXIS_STEP_MIN,
  PX_PER_STEP,
  GRID_PX,
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
  parseDiaryPin,
  parseCompleteMeta,
  isSkippedChange,
  insertDecompressStrips,
  warnDrop,
  weeksFrom,
  weekCapacity,
  mergeIntervals,
  attachWeekCapacity,
  isZoomClientBooking,
  blockTypeFromBusy,
};
