/**
 * Diary assembly + drop warn-checks.
 * Warn-checks call habit-placer-lib exports (never a flat reimplemented gap).
 */
const { isoToLondonDate, isoToLondonMinutes, ruleMapFromRows, workingWindow, isSchedulableDay, bankHolidaySet } = require('./scheduling-rules-lib');
const { splitMcAndBusy } = require('./rule-breach-lib');
const {
  requiredGapMins, dayCapLimits, awaySpansFromTravelBlocks, dayInsideAwaySpan,
  dayBlockedForPlacement, teachingDaySpansFromEvents, restDaySpansFromWorkshopEvents,
  teachingDayRuleEnabled, awayBusySegments, partialAwayMinsOnDay, intervalInsideAwaySpan,
  londonYmdHmToUtcMs,
} = require('./habit-placer-lib');
const { isForceBusyCalendar, EXPECTED_CALENDARS } = require('./gcal-lib');

/** 05:00–23:00 so Peak sunrise / early travel legs are visible (was 07:00). */
const DAY_START_MIN = 5 * 60;
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
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return null;
  }
  const day = isoToLondonDate(start);
  const sMin = isoToLondonMinutes(start);
  const eMin = isoToLondonMinutes(end);
  if (day == null || sMin == null || eMin == null) return null;
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
    hotel_id: opts.hotel_id || null,
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
    const mins = Number(t.actual_minutes || t.est_minutes || 30);
    let start = t.scheduled_start;
    let end = t.scheduled_end;
    // Done work sits at the moment it was marked done, not the old plan.
    if (done) {
      const doneAt = t.last_activity_at || t.completed_at || null;
      if (doneAt && Number.isFinite(Date.parse(doneAt))) {
        start = new Date(doneAt).toISOString();
        end = new Date(Date.parse(doneAt) + Math.max(15, mins) * 60000).toISOString();
      } else if (t.actual_minutes && t.scheduled_start) {
        const startMs = Date.parse(t.scheduled_start);
        if (Number.isFinite(startMs)) {
          end = new Date(startMs + Number(t.actual_minutes) * 60000).toISOString();
        }
      }
    }
    return toBlock({
      id: `task:${t.id}`,
      kind: 'mc_task',
      title: t.title || `MC-${t.display_id}`,
      start,
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
  }).filter(Boolean);
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
  })).filter(Boolean);
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
    // Placement-only expansions (±fixture_buffer) — never paint as diary blocks.
    if (e.hard_fixture) continue;
    const start = e.start?.dateTime || e.start;
    const end = e.end?.dateTime || e.end;
    if (!start || !String(start).includes('T')) continue;
    const kind = blockTypeFromBusy(e);
    const title = e.summary || '(busy)';
    const clientFixed = kind === 'workshop' || isZoomClientBooking(title);
    const busyBlock = toBlock({
      id: `busy:${e.id}`,
      kind,
      title,
      start,
      end,
      editable: false,
      slot_pinned: clientFixed,
      priority: clientFixed ? 'p0' : null,
      client_fixed: clientFixed,
      calendar_event_id: e.id || null,
    });
    if (busyBlock) out.push(busyBlock);
  }
  for (const e of fixtures || []) {
    const title = e.summary || 'Fixture';
    const isFlank = /MC\s*⚽\s*(Before|After)\s*:/i.test(title) || /Before:|After:/i.test(title) && /MC\s*⚽/i.test(title);
    const fixBlock = toBlock({
      id: `fix:${e.id}`,
      kind: isFlank ? 'buffer' : 'fixture',
      title,
      start: e.start,
      end: e.end,
      editable: false,
      calendar_event_id: e.id || null,
      is_buffer: isFlank,
    });
    if (fixBlock) out.push(fixBlock);
  }
  return out;
}

/**
 * DB pre/post strips only when Primary GCal flanks are missing.
 * When before_event_id / after_event_id exist, Google already owns the paint.
 */
function fixtureFlanksToBlocks(rows) {
  const out = [];
  for (const r of rows || []) {
    // Live MC ⚽ Before/After on Primary — do not invent a second pair.
    if (r.before_event_id || r.after_event_id) continue;
    const label = String(r.title || 'Fixture').replace(/^⚽️\s*/, '').trim();
    const fixStart = asIso(r.fixture_start);
    const fixEnd = asIso(r.fixture_end);
    const blockStart = asIso(r.block_start);
    const blockEnd = asIso(r.block_end);
    if (blockStart && fixStart) {
      const before = toBlock({
        id: `fix-before:${r.fixture_event_id || r.id}`,
        kind: 'buffer',
        title: `pre-match · ${label}`,
        start: blockStart,
        end: fixStart,
        editable: false,
        is_buffer: true,
      });
      if (before) out.push(before);
    }
    if (fixEnd && blockEnd) {
      const after = toBlock({
        id: `fix-after:${r.fixture_event_id || r.id}`,
        kind: 'buffer',
        title: `post-match · ${label}`,
        start: fixEnd,
        end: blockEnd,
        editable: false,
        is_buffer: true,
      });
      if (after) out.push(after);
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
  // diary_pin:<start>|<end> optionally followed by |note — never let the note poison end ISO.
  const m = String(change || '').match(/^diary_pin:([^|]+)\|([^|]+)/);
  if (!m) return null;
  const start = m[1].trim();
  const end = m[2].trim();
  if (!Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end))) return null;
  return { start, end };
}

function parseCompleteMeta(change) {
  const m = String(change || '').match(
    /^completed\s+(\d{4}-\d{2}-\d{2})(?:\|actual=(\d+))?(?:\|at=([^|]+))?/i,
  );
  if (!m) return null;
  return {
    date: m[1],
    actual_min: m[2] != null ? Number(m[2]) : null,
    at: m[3] ? String(m[3]).trim() : null,
  };
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
    if (done && doneMeta?.at && Number.isFinite(Date.parse(doneMeta.at))) {
      startIso = new Date(doneMeta.at).toISOString();
      endIso = new Date(Date.parse(doneMeta.at) + dur * 60000).toISOString();
    } else if (done && log.at && Number.isFinite(Date.parse(log.at))) {
      startIso = new Date(log.at).toISOString();
      endIso = new Date(Date.parse(log.at) + dur * 60000).toISOString();
    } else if (pin?.start && pin?.end && !done) {
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
    const habitBlock = toBlock({
      id: `habit:${habit.id}:${day}`,
      kind: 'habit',
      title: habit.title,
      start: startIso,
      end: endIso,
      editable: !done,
      slot_pinned: !!(pin && !done),
      habit_id: habit.id,
      ideal_date: ideal,
      calendar_event_id: log.calendar_event_id || null,
      priority: habit.priority || null,
      done,
      actual_minutes: actual,
    });
    if (habitBlock) out.push(habitBlock);
  }
  return out;
}

const GCAL_DRIFT_TOLERANCE_MIN = 5;

/** Index Primary events by id for Diary visual baseline. */
function indexGcalEventsById(events) {
  const map = new Map();
  for (const e of events || []) {
    if (!e?.id) continue;
    const start = e.start?.dateTime || e.start;
    const end = e.end?.dateTime || e.end;
    if (!start || !String(start).includes('T')) continue;
    map.set(e.id, {
      id: e.id,
      start: String(start),
      end: end ? String(end) : String(start),
      summary: e.summary || null,
    });
  }
  return map;
}

/**
 * Align tied blocks with Google when DB is not intentionally pinned.
 * After a diary drag, slot_pinned / diary_pin means DB wins until Push.
 */
function applyGcalBaselineTimes(blocks, eventById, toleranceMin = GCAL_DRIFT_TOLERANCE_MIN) {
  let driftCount = 0;
  const out = (blocks || []).map((b) => {
    if (b.done || !b.calendar_event_id) {
      return { ...b, gcal_baseline: false, out_of_sync: false, awaiting_push: false };
    }
    // Pin points at a dead/missing Primary event — Diary ghost until reconcile recreates it.
    if (!eventById?.has(b.calendar_event_id)) {
      return {
        ...b,
        gcal_baseline: false,
        out_of_sync: true,
        awaiting_push: true,
        gcal_missing: true,
      };
    }
    const g = eventById.get(b.calendar_event_id);
    const dbStart = b.start;
    const dbEnd = b.end;
    const dbDay = b.day;
    const startMs = Date.parse(g.start);
    const endMs = Date.parse(g.end);
    const dbStartMs = Date.parse(dbStart);
    const dbEndMs = Date.parse(dbEnd || dbStart);
    const driftStart = Number.isFinite(startMs) && Number.isFinite(dbStartMs)
      ? Math.abs(startMs - dbStartMs) / 60000
      : 0;
    const driftEnd = Number.isFinite(endMs) && Number.isFinite(dbEndMs)
      ? Math.abs(endMs - dbEndMs) / 60000
      : 0;
    const outOfSync = driftStart > toleranceMin || driftEnd > toleranceMin;
    if (!outOfSync) {
      return {
        ...b,
        gcal_baseline: true,
        out_of_sync: false,
        awaiting_push: false,
      };
    }
    driftCount += 1;
    // User moved / pinned in MC — keep DB slot visible; Push will update Google.
    if (b.slot_pinned) {
      return {
        ...b,
        gcal_baseline: false,
        out_of_sync: true,
        awaiting_push: true,
        gcal_start: g.start,
        gcal_end: g.end,
        gcal_day: isoToLondonDate(g.start),
      };
    }
    // DB is stale ideal — paint Google.
    const start_min = isoToLondonMinutes(g.start);
    const end_min = isoToLondonMinutes(g.end);
    return {
      ...b,
      start: g.start,
      end: g.end,
      day: isoToLondonDate(g.start),
      start_min,
      end_min,
      duration_min: Math.max(0, end_min - start_min),
      gcal_baseline: true,
      out_of_sync: true,
      awaiting_push: false,
      db_start: dbStart,
      db_end: dbEnd,
      db_day: dbDay,
    };
  });
  return { blocks: out, drift_count: driftCount };
}

/** Untied Primary MC events — visible read-only orphans. */
function untiedMcBlocks(mcEvents, tiedIds) {
  const fixedRe = /Travel out|Travel back|Travel —|Decompress|AWAY —|REST —|^MC 🚗|^MC ⏳|^MC 🚫|^MC 🛌/i;
  const out = [];
  for (const e of mcEvents || []) {
    if (!e?.id || (tiedIds && tiedIds.has(e.id))) continue;
    const start = e.start?.dateTime || e.start;
    const end = e.end?.dateTime || e.end;
    if (!start || !String(start).includes('T')) continue;
    const title = e.summary || 'MC block';
    // Deadlines are owned by hotelDeadlineBlocks (editable complete/skip).
    if (/MC\s*⏰/i.test(title) && /Hotel deadline|Hotel decision|Room release|cancel by/i.test(title)) {
      continue;
    }
    const kind = /travel/i.test(title)
      ? 'travel'
      : (/decompress|buffer/i.test(title) ? 'buffer' : 'habit');
    const done = /^DONE\b/i.test(title.trim());
    const block = toBlock({
      id: `gcal-mc:${e.id}`,
      kind,
      title,
      start: String(start),
      end: end ? String(end) : String(start),
      editable: false,
      calendar_event_id: e.id,
      done,
    });
    if (!block) continue;
    block.gcal_orphan = true;
    block.gcal_baseline = true;
    block.read_only = true;
    block.out_of_sync = false;
    if (fixedRe.test(title)) block.client_fixed = false;
    out.push(block);
  }
  return out;
}

/**
 * Hotel / room-release reminders → editable deadline blocks (Mark complete / Skip).
 * Linked via workshop_hotels.reminder_event_id when present.
 */
function hotelDeadlineBlocks(mcEvents, hotelByEventId) {
  const out = [];
  const seen = new Set();
  for (const e of mcEvents || []) {
    if (!e?.id || seen.has(e.id)) continue;
    const start = e.start?.dateTime || e.start;
    const end = e.end?.dateTime || e.end;
    if (!start || !String(start).includes('T')) continue;
    const title = e.summary || '';
    const hotel = hotelByEventId?.get(e.id) || null;
    const isDeadline = !!hotel
      || (/MC\s*⏰/i.test(title)
        && /Hotel deadline|Hotel decision|Room release|cancel by/i.test(title));
    if (!isDeadline) continue;
    seen.add(e.id);
    const block = toBlock({
      id: hotel ? `deadline:${hotel.id}` : `deadline-gcal:${e.id}`,
      kind: 'deadline',
      title,
      start: String(start),
      end: end ? String(end) : String(start),
      editable: true,
      calendar_event_id: e.id,
      hotel_id: hotel?.id || null,
    });
    if (!block) continue;
    block.gcal_baseline = true;
    block.hotel_name = hotel?.hotel || null;
    block.cancel_by = hotel?.free_cancel_until || null;
    out.push(block);
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
 * Decompress visibility: Google is source of truth for painted buffers.
 * Gap-buffer / travel decompress arrive via GCal orphans + travel_blocks.
 * Do not invent synthetic strips — they desync Mission Control from Google.
 */
function insertDecompressStrips(blocks) {
  return [...(blocks || [])];
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
  if (dayBlockedForPlacement(day, awaySpans)) {
    const awayOnly = dayInsideAwaySpan(day, awaySpans);
    warnings.push(awayOnly
      ? 'Away middle day (between travel-out and travel-back)'
      : 'Blocked day (post-residential rest — no habits/tasks)');
  } else if (intervalInsideAwaySpan(day, startMin, endMin, awaySpans)) {
    warnings.push('Away — between travel-out and travel-back');
  }
  if ((peers || []).some((p) => p.day === day
    && (p.kind === 'workshop' || p.kind === 'lesson' || p.client_fixed))) {
    warnings.push('Teaching/client day — no habits/tasks');
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

/** On-location residential / away day clock (Alan's model ~05:00–22:00). */
const AWAY_DAY_START_MIN = 5 * 60;
const AWAY_DAY_END_MIN = 22 * 60;
const EVENING_CATCHUP_START = 19 * 60;
const EVENING_CATCHUP_END = 21 * 60;

function blocksOnDay(blocks, day) {
  return (blocks || []).filter((b) => b.day === day && !b.synthetic);
}

function dayIsTeaching(dayBlocks) {
  return dayBlocks.some((b) => b.kind === 'workshop' || b.kind === 'lesson' || b.client_fixed);
}

function dayHasEveningCommitment(dayBlocks) {
  return dayBlocks.some((b) => {
    if ((b.start_min || 0) < 17 * 60) return false;
    return b.kind === 'workshop' || b.kind === 'lesson' || b.kind === 'fixture' || b.client_fixed;
  });
}

function mergedMins(dayBlocks) {
  const intervals = [];
  for (const b of dayBlocks) {
    const s = b.start_min || 0;
    const e = b.end_min || 0;
    if (e > s) intervals.push([s, e]);
  }
  return mergeIntervals(intervals).reduce((n, [s, e]) => n + (e - s), 0);
}

function kindMinutes(dayBlocks) {
  const out = {};
  for (const b of dayBlocks) {
    const kind = b.kind === 'mc_task' ? 'task' : (b.kind || 'other');
    const dur = Math.max(0, (b.end_min || 0) - (b.start_min || 0));
    out[kind] = (out[kind] || 0) + dur;
  }
  return out;
}

/**
 * Realistic week load (Alan's model):
 * - Away/residential day: committed = full ~05–22; capacity = same (no admin gaps).
 * - Teaching/client day (workshop/lesson/1-2-1): committed = all blocks; capacity = committed
 *   (no free admin slots to “fill”).
 * - Normal desk day: capacity = core working window + optional 19–21 catch-up
 *   (catch-up dropped if evening class/fixture); committed = merged timed blocks.
 */
function weekCapacity(days, blocks, awayDays, ruleMap, holidays, awaySpans = []) {
  let available = 0;
  let filled = 0;
  let awayDaysCounted = 0;
  let teachingDays = 0;
  const breakdown = {
    away: 0, workshop: 0, lesson: 0, travel: 0, habit: 0, deadline: 0, task: 0,
    fixture: 0, personal: 0, buffer: 0, other: 0,
  };

  for (const day of days || []) {
    const dayMeta = awayDays?.[day];
    const dayKind = dayMeta?.kind || (dayMeta ? 'away_span' : null);
    const dayBlocks = blocksOnDay(blocks, day);
    const km = kindMinutes(dayBlocks);
    for (const [k, v] of Object.entries(km)) {
      if (breakdown[k] != null) breakdown[k] += v;
      else breakdown.other += v;
    }

    // Rest day after multi-day workshop: protected — no admin capacity.
    if (dayKind === 'rest_after_workshop' || dayKind === 'rest_after_away') continue;

    // Residential / bank holiday away.
    if (dayKind === 'away_span' || (!dayKind && holidays && holidays.has(day))) {
      const span = AWAY_DAY_END_MIN - AWAY_DAY_START_MIN;
      available += span;
      filled += span;
      breakdown.away += span;
      awayDaysCounted += 1;
      continue;
    }

    // Teaching / client day (tagged or inferred from blocks).
    // Teaching/client whole-day ownership — only when rule enabled.
    if (teachingDayRuleEnabled(ruleMap)
      && (dayKind === 'teaching_day' || dayIsTeaching(dayBlocks))) {
      teachingDays += 1;
      const committed = mergedMins(dayBlocks);
      available += Math.max(committed, 1);
      filled += committed;
      continue;
    }

    const committed = mergedMins(dayBlocks);
    const win = workingWindow(ruleMap || {}, day);
    const w0 = win.start_min ?? 10 * 60;
    const w1 = win.end_min ?? 17 * 60;
    let dayCap = Math.max(0, w1 - w0);
    if (!dayHasEveningCommitment(dayBlocks)) {
      dayCap += (EVENING_CATCHUP_END - EVENING_CATCHUP_START);
    }
    // Travel-out → travel-back edge hours are not free admin time.
    const awayCover = partialAwayMinsOnDay(
      day, awaySpans, AWAY_DAY_START_MIN, AWAY_DAY_END_MIN,
    );
    const awayExtra = Math.max(0, awayCover - committed);
    if (awayExtra > 0) breakdown.away += awayExtra;
    available += dayCap;
    filled += committed + awayExtra;
  }

  const pct = available > 0 ? Math.round((filled / available) * 100) : (filled > 0 ? 100 : 0);
  const filledH = Math.round((filled / 60) * 10) / 10;
  const availH = Math.round((available / 60) * 10) / 10;
  const breakdown_h = {};
  for (const [k, v] of Object.entries(breakdown)) {
    if (v > 0) breakdown_h[k] = Math.round((v / 60) * 10) / 10;
  }
  const movableMin = (breakdown.habit || 0) + (breakdown.deadline || 0) + (breakdown.task || 0);
  const fixedMin = Object.entries(breakdown)
    .filter(([k]) => k !== 'habit' && k !== 'task')
    .reduce((s, [, v]) => s + v, 0);
  return {
    available_min: available,
    filled_min: filled,
    free_min: Math.max(0, available - filled),
    pct: Math.min(pct, 999),
    over: filled > available,
    away_days: awayDaysCounted,
    teaching_days: teachingDays,
    breakdown_min: breakdown,
    breakdown_h,
    movable_min: movableMin,
    fixed_min: fixedMin,
    movable_h: Math.round((movableMin / 60) * 10) / 10,
    fixed_h: Math.round((fixedMin / 60) * 10) / 10,
    label: `${Math.min(pct, 999)}% · ${filledH}h committed / ${availH}h realistic`,
  };
}

function attachWeekCapacity(weeks, blocks, awayDays, ruleMap, awaySpans = []) {
  const fromY = (weeks?.[0]?.days?.[0] || '').slice(0, 4);
  const toY = (weeks?.[weeks.length - 1]?.days?.[6] || fromY).slice(0, 4);
  const holidays = bankHolidaySet(Number(fromY) || 2026, Number(toY) || 2026);
  return (weeks || []).map((w) => ({
    ...w,
    capacity: weekCapacity(w.days, blocks, awayDays, ruleMap, holidays, awaySpans),
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
  teachingDaySpansFromEvents,
  teachingDayRuleEnabled,
  restDaySpansFromWorkshopEvents,
  dayBlockedForPlacement,
  awayBusySegments,
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
  indexGcalEventsById,
  applyGcalBaselineTimes,
  untiedMcBlocks,
  hotelDeadlineBlocks,
  GCAL_DRIFT_TOLERANCE_MIN,
  insertDecompressStrips,
  warnDrop,
  weeksFrom,
  weekCapacity,
  mergeIntervals,
  attachWeekCapacity,
  isZoomClientBooking,
  blockTypeFromBusy,
};
