/**
 * Joint habit placer (offline spike) — pure, no Calendar writes.
 * Busy map frozen first → habits by dep-topology then hardest-first → amendments.
 */
const {
  workingWindow, isSchedulableDay, isoToLondonDate, isoToLondonMinutes, addDays,
} = require('./scheduling-rules-lib');
const { occurrencesInRange, criticalRollMode } = require('./rrule-core');
const { priorityRank } = require('./priority-lib');
const { isMcBlock, isFixtureBlock } = require('./rule-breach-lib');
const { isForceBusyCalendar } = require('./gcal-lib');

function parseHm(hm) {
  const [h, m] = String(hm || '09:00').slice(0, 5).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

function hmLabel(mins) {
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

/** UTC ms for a London wall-clock ymd + HH:MM. */
function londonYmdHmToUtcMs(ymd, hm) {
  const want = parseHm(hm);
  let t = Date.parse(`${ymd}T${String(hm).slice(0, 5)}:00.000Z`);
  for (let i = 0; i < 48; i += 1) {
    const iso = new Date(t).toISOString();
    const day = isoToLondonDate(iso);
    if (day !== ymd) {
      t += (ymd > day ? 1 : -1) * 3600000;
      continue;
    }
    const got = isoToLondonMinutes(iso);
    if (got === want) return t;
    t += (want - got) * 60000;
  }
  return t;
}

function overlaps(a0, a1, b0, b1) {
  return a0 < b1 && b0 < a1;
}

function dayCapLimits(ruleMap) {
  const cap = Number(ruleMap.daily_task_cap_min || 240);
  const tol = Number(ruleMap.daily_task_cap_tolerance_min || 30);
  return { target: cap, hard: cap + tol };
}

/**
 * Multi-day residential away spans from travel_out + travel_back pairs.
 * Busy interval = travel_out start → travel_back end (you are away the whole time).
 * Whole-day AWAY banner / placement skip = middle days only; edge days use
 * startMs–endMs (and awayBusySegments) so morning-before-outbound stays free.
 * Same-day day-trips skipped (drive intervals already cover those).
 */
function awaySpansFromTravelBlocks(blocks) {
  const outs = [];
  const backs = [];
  for (const b of blocks || []) {
    if (!b?.starts_at || !b?.ends_at) continue;
    if (b.block_type === 'travel_out') outs.push(b);
    else if (b.block_type === 'travel_back') backs.push(b);
  }
  outs.sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
  backs.sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));

  const pairKey = (b) => b.workshop_row_key || `${b.venue_name || ''}|${b.workshop_start || ''}`;
  const usedBack = new Set();
  const spans = [];

  for (const out of outs) {
    const key = pairKey(out);
    const outMs = Date.parse(out.starts_at);
    let backIdx = backs.findIndex((bk, i) => !usedBack.has(i) && pairKey(bk) === key
      && Date.parse(bk.starts_at) >= outMs);
    if (backIdx < 0) {
      backIdx = backs.findIndex((bk, i) => !usedBack.has(i) && Date.parse(bk.starts_at) >= outMs);
    }
    if (backIdx < 0) continue;
    usedBack.add(backIdx);
    const back = backs[backIdx];
    const startDay = isoToLondonDate(out.starts_at);
    const endDay = isoToLondonDate(back.ends_at);
    if (!startDay || !endDay || endDay < startDay || startDay === endDay) continue;
    const startMs = Date.parse(out.starts_at);
    const endMs = Date.parse(back.ends_at);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
    // All-day AWAY banner / GCal master = middle days only (edges are travel blocks).
    const middleStart = addDays(startDay, 1);
    const middleEnd = addDays(endDay, -1);
    spans.push({
      startDay,
      endDay,
      middleStart: middleStart <= middleEnd ? middleStart : null,
      middleEnd: middleStart <= middleEnd ? middleEnd : null,
      restDay: null,
      startMs,
      endMs,
      partial_edges: true,
      summary: `away:${out.venue_name || out.workshop_title || key}`,
      kind: 'away_span',
    });
  }
  return spans.sort((a, b) => a.startMs - b.startMs);
}

/** Editable toggle — day after last day of each multi-day workshop event. */
function restDayRuleEnabled(ruleMap = {}) {
  if (ruleMap.rest_day_after_multiday_workshop != null) {
    return String(ruleMap.rest_day_after_multiday_workshop) === 'true';
  }
  return true;
}

function isWorkshopCalendarEvent(e) {
  const cal = String(e?._calendarId || e?.calendarId || '');
  return cal.includes('ic364d06');
}

/**
 * Events that can mint a rest day: Workshops calendar, plus non-MC
 * workshop/masterclass events on other calendars (e.g. guest David Ward on primary).
 */
function isRestDaySourceEvent(e) {
  if (isWorkshopCalendarEvent(e)) return true;
  const title = String(e?.summary || '');
  if (!title || /^MC\b/i.test(title)) return false;
  return /workshop|masterclass/i.test(title);
}

/** London first/last day of one GCal event (all-day end is exclusive). */
function workshopEventDayRange(e) {
  if (e.start?.date && !e.start?.dateTime) {
    const firstDay = e.start.date;
    const endEx = e.end?.date || addDays(firstDay, 1);
    if (!firstDay || endEx <= firstDay) return null;
    return { firstDay, lastDay: addDays(endEx, -1) };
  }
  const startRaw = e.start?.dateTime || (typeof e.start === 'string' ? e.start : null);
  const endRaw = e.end?.dateTime || (typeof e.end === 'string' ? e.end : null);
  if (!startRaw) return null;
  const firstDay = isoToLondonDate(String(startRaw));
  if (!firstDay) return null;
  let lastDay = endRaw ? isoToLondonDate(String(endRaw)) : firstDay;
  if (!lastDay) lastDay = firstDay;
  if (endRaw && lastDay > firstDay && isoToLondonMinutes(String(endRaw)) === 0) {
    lastDay = addDays(lastDay, -1);
  }
  if (lastDay < firstDay) lastDay = firstDay;
  return { firstDay, lastDay };
}

/**
 * Rest day = day AFTER last day of each multi-day (2+ London days) workshop event.
 * Per-event ranges only — never group by title. Travel is irrelevant.
 * Toggle: scheduling_rules.rest_day_after_multiday_workshop (default true).
 */
function restDaySpansFromWorkshopEvents(events, ruleMap = {}) {
  if (!restDayRuleEnabled(ruleMap)) return [];
  const byRest = new Map();
  for (const e of events || []) {
    if (!isRestDaySourceEvent(e)) continue;
    const range = workshopEventDayRange(e);
    if (!range || range.lastDay <= range.firstDay) continue;
    const restDay = addDays(range.lastDay, 1);
    const title = e.summary || 'workshop';
    const row = {
      startDay: restDay,
      endDay: restDay,
      restDay,
      firstDay: range.firstDay,
      lastDay: range.lastDay,
      startMs: londonYmdHmToUtcMs(restDay, '00:00'),
      endMs: londonYmdHmToUtcMs(restDay, '23:59') + 60000,
      summary: `rest after multi-day: ${title}`,
      workshop_title: title,
      kind: 'rest_after_workshop',
    };
    const prev = byRest.get(restDay);
    if (!prev || range.lastDay > prev.lastDay) byRest.set(restDay, row);
  }
  return [...byRest.values()].sort((a, b) => a.startMs - b.startMs);
}

/** Reporting rows (ignores toggle) — one per multi-day workshop event. */
function multidayWorkshopRestRows(events) {
  const rows = [];
  for (const e of events || []) {
    if (!isRestDaySourceEvent(e)) continue;
    const range = workshopEventDayRange(e);
    if (!range || range.lastDay <= range.firstDay) continue;
    rows.push({
      title: e.summary || 'workshop',
      firstDay: range.firstDay,
      lastDay: range.lastDay,
      restDay: addDays(range.lastDay, 1),
      event_id: e.id || null,
    });
  }
  return rows.sort((a, b) => a.firstDay.localeCompare(b.firstDay)
    || a.title.localeCompare(b.title));
}

/** Middle away days only when partial_edges (full-day AWAY column). */
function dayInsideAwaySpan(day, spans) {
  return (spans || []).some((s) => {
    if (s.kind === 'teaching_day') return false;
    if (s.kind === 'away_span' && s.partial_edges) {
      if (!s.middleStart || !s.middleEnd) return false;
      return day >= s.middleStart && day <= s.middleEnd;
    }
    return day >= s.startDay && day <= s.endDay;
  });
}

/**
 * Timed away overlays for diary hatch + capacity: each London day slice of
 * [startMs, endMs] clipped to [clipStartMin, clipEndMin].
 */
function awayBusySegments(spans, clipStartMin = 7 * 60, clipEndMin = 23 * 60) {
  const out = [];
  for (const s of spans || []) {
    if (s.kind && s.kind !== 'away_span') continue;
    if (!Number.isFinite(s.startMs) || !Number.isFinite(s.endMs)) continue;
    if (!s.startDay || !s.endDay) continue;
    let d = s.startDay;
    while (d <= s.endDay) {
      const dayLo = londonYmdHmToUtcMs(d, hmLabel(clipStartMin));
      const dayHi = londonYmdHmToUtcMs(d, hmLabel(clipEndMin));
      const lo = Math.max(dayLo, s.startMs);
      const hi = Math.min(dayHi, s.endMs);
      if (hi > lo) {
        let startMin = isoToLondonMinutes(new Date(lo).toISOString());
        let endMin = isoToLondonMinutes(new Date(hi).toISOString());
        const endDay = isoToLondonDate(new Date(hi).toISOString());
        if (endDay > d) endMin = clipEndMin;
        startMin = Math.max(clipStartMin, startMin);
        endMin = Math.min(clipEndMin, endMin);
        if (endMin > startMin) {
          out.push({
            day: d,
            start_min: startMin,
            end_min: endMin,
            summary: s.summary || null,
            kind: 'away_span',
          });
        }
      }
      d = addDays(d, 1);
    }
  }
  return out;
}

function partialAwayMinsOnDay(day, spans, clipStartMin, clipEndMin) {
  return awayBusySegments(spans, clipStartMin, clipEndMin)
    .filter((seg) => seg.day === day)
    .reduce((n, seg) => n + (seg.end_min - seg.start_min), 0);
}

/** True if [startMin,endMin] on day overlaps a residential away busy interval. */
function intervalInsideAwaySpan(day, startMin, endMin, spans) {
  const startMs = londonYmdHmToUtcMs(day, hmLabel(startMin));
  const endMs = londonYmdHmToUtcMs(day, hmLabel(endMin));
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return false;
  return (spans || []).some((s) => s.kind === 'away_span'
    && Number.isFinite(s.startMs) && Number.isFinite(s.endMs)
    && overlaps(startMs, endMs, s.startMs, s.endMs));
}

/** Away middle days + post-residential rest + teaching — no habits/tasks. */
function dayBlockedForPlacement(day, spans) {
  return (spans || []).some((s) => {
    if (s.kind === 'teaching_day') return day === s.startDay;
    if (s.kind === 'away_span' && s.partial_edges) {
      if (!s.middleStart || !s.middleEnd) return false;
      return day >= s.middleStart && day <= s.middleEnd;
    }
    if (day >= s.startDay && day <= s.endDay) return true;
    return !!(s.restDay && day === s.restDay);
  });
}

/**
 * Habits: rest + teaching + FULL away span (travel edge days included).
 * Peak-style 2-day trips have no middle — tasks may use edge mornings; habits may not.
 */
function dayBlockedForHabits(day, spans) {
  return (spans || []).some((s) => {
    if (s.kind === 'teaching_day') return day === s.startDay;
    if (s.kind === 'away_span') {
      return !!(s.startDay && s.endDay && day >= s.startDay && day <= s.endDay);
    }
    if (s.kind === 'rest_after_workshop' || s.restDay) {
      return day === String(s.restDay || s.startDay);
    }
    if (s.startDay && s.endDay && day >= s.startDay && day <= s.endDay) return true;
    return false;
  });
}

/** DB rest_day_blocks → same shape as workshop-derived rest spans. */
function restDaySpansFromDbRows(rows) {
  return (rows || []).filter((r) => r?.rest_date).map((r) => {
    const restDay = String(r.rest_date).slice(0, 10);
    return {
      startDay: restDay,
      endDay: restDay,
      restDay,
      kind: 'rest_after_workshop',
      summary: `rest after multi-day: ${r.workshop_title || restDay}`,
      workshop_title: r.workshop_title || null,
      startMs: londonYmdHmToUtcMs(restDay, '00:00'),
      endMs: londonYmdHmToUtcMs(restDay, '23:59') + 60000,
    };
  });
}

function coveringBlockedSpan(day, spans) {
  return (spans || []).find((s) => {
    if (s.kind === 'teaching_day') return day === s.startDay;
    if (s.kind === 'away_span' && s.partial_edges) {
      if (!s.middleStart || !s.middleEnd) return false;
      return day >= s.middleStart && day <= s.middleEnd;
    }
    if (day >= s.startDay && day <= s.endDay) return true;
    return !!(s.restDay && day === s.restDay);
  }) || null;
}

/** Paid Zoom / online 1-2-1 — same rule as diary purple client bookings. */
function isZoomClientBooking(summary) {
  const t = String(summary || '').toLowerCase();
  const is121 = /1\s*[-–]?\s*2\s*[-–]?\s*1|\b121\b/.test(t);
  if (is121 && /zoom|online|tuition|mentoring|1-2-1/.test(t)) return true;
  if (/\bonline\b/.test(t) && is121) return true;
  if (/\bzoom\b/.test(t) && /(tuition|mentoring|1\s*[-–]?\s*2\s*[-–]?\s*1)/.test(t)) return true;
  return false;
}

function isTeachingCalendarEvent(e) {
  const title = e?.summary || e?.title || '';
  if (isZoomClientBooking(title)) return true;
  const cal = String(e?._calendarId || e?.calendarId || '');
  if (!cal) return false;
  if (isForceBusyCalendar(cal)) return false;
  if (cal.includes('ic364d06')) return true; // Workshops
  if (cal.includes('nht93uaq')) return true; // Lessons
  return false;
}

/**
 * Whole-day teaching/client block — DISABLED by default until baseline is stable.
 * Toggle: scheduling_rules.teaching_day_whole_day_block (default false).
 */
function teachingDayRuleEnabled(ruleMap = {}) {
  return String(ruleMap.teaching_day_whole_day_block || 'false') === 'true';
}

/**
 * Whole-day hard blocks for workshop / lesson / Zoom 1-2-1 days.
 * Only when teaching_day_whole_day_block=true.
 */
function teachingDaySpansFromEvents(events, ruleMap = {}) {
  if (!teachingDayRuleEnabled(ruleMap)) return [];
  const byDay = new Map();
  for (const e of events || []) {
    if (!isTeachingCalendarEvent(e)) continue;
    if (e.start?.date && !e.start?.dateTime) {
      let d = e.start.date;
      const endDay = e.end?.date || addDays(d, 1);
      while (d < endDay) {
        byDay.set(d, e.summary || 'teaching');
        d = addDays(d, 1);
      }
      continue;
    }
    const startRaw = e.start?.dateTime || e.start;
    const endRaw = e.end?.dateTime || e.end || startRaw;
    if (!startRaw || !String(startRaw).includes('T')) continue;
    let d = isoToLondonDate(String(startRaw));
    const last = isoToLondonDate(String(endRaw)) || d;
    if (!d) continue;
    while (d && d <= last) {
      byDay.set(d, e.summary || 'teaching');
      if (d === last) break;
      d = addDays(d, 1);
    }
  }
  return [...byDay.entries()].map(([day, summary]) => ({
    startDay: day,
    endDay: day,
    restDay: null,
    startMs: londonYmdHmToUtcMs(day, '00:00'),
    endMs: londonYmdHmToUtcMs(day, '23:59') + 60000,
    summary: `teaching:${summary}`,
    kind: 'teaching_day',
  })).sort((a, b) => a.startMs - b.startMs);
}

/**
 * Busy intervals from mixed events.
 * Skip MC admin/habit titles — except fixture markers (MC ⚽), which are HARD-BUSY
 * (Alan 2026-07-27: Ipswich fixtures block like workshops/tuition).
 * Ipswich calendar events always hard-busy + fixture_buffer_min expansion.
 */
function buildBusyIntervals(events, ruleMap = {}) {
  const buffer = Number(ruleMap.fixture_buffer_min || 60);
  const out = [];
  for (const e of events || []) {
    const calId = e._calendarId || e.calendarId;
    const force = isForceBusyCalendar(calId);
    const fixtureMc = isFixtureBlock(e, ruleMap);
    // MC admin/habits out of busy; fixture flanks stay in (hard-busy).
    if (isMcBlock(e) && !fixtureMc) continue;
    if (e.transparency === 'transparent' && !force && !fixtureMc) continue;

    if (e.start?.date && !e.start?.dateTime) {
      let d = e.start.date;
      const endDay = e.end?.date || addDays(d, 1);
      while (d < endDay) {
        out.push({
          startMs: londonYmdHmToUtcMs(d, '00:00'),
          endMs: londonYmdHmToUtcMs(d, '23:59') + 60000,
          summary: e.summary || 'all-day',
        });
        d = addDays(d, 1);
      }
      continue;
    }

    const startRaw = e.start?.dateTime || e.start;
    const endRaw = e.end?.dateTime || e.end;
    if (!startRaw || !String(startRaw).includes('T')) continue;
    let startMs = Date.parse(startRaw);
    let endMs = Date.parse(endRaw || startRaw);
    if (force || fixtureMc) {
      startMs -= buffer * 60000;
      endMs += buffer * 60000;
    }
    out.push({ startMs, endMs, summary: e.summary || '' });
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

const DONE_TASK_STATES = new Set(['done', 'verified', 'wont_do', 'superseded']);

/**
 * Dated one-off MC tasks → intervals.
 * pinnedOnly=true → hard busy (habits flow around).
 * pinnedOnly=false → soft (habits outrank; overlaps become bumps).
 */
function datedTasksToIntervals(tasks, { pinnedOnly = false } = {}) {
  const out = [];
  for (const t of tasks || []) {
    if (!t?.scheduled_start || DONE_TASK_STATES.has(String(t.state || ''))) continue;
    const pinned = t.slot_pinned === true;
    if (pinnedOnly && !pinned) continue;
    if (!pinnedOnly && pinned) continue;
    const startMs = Date.parse(t.scheduled_start);
    const endMs = Date.parse(t.scheduled_end || t.scheduled_start);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
    out.push({
      startMs,
      endMs,
      summary: `MC-${t.display_id} ${t.title || ''}`.trim(),
      display_id: t.display_id,
      slot_pinned: pinned,
      kind: 'dated_task',
      calendar_event_id: t.calendar_event_id || null,
      depends_on_display_id: t.depends_on_display_id != null
        ? Number(t.depends_on_display_id)
        : null,
    });
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

function expandBumpsWithDependents(bumps, softTaskIntervals) {
  const out = new Map();
  for (const b of bumps || []) out.set(Number(b.display_id), b);

  let grew = true;
  while (grew) {
    grew = false;
    for (const t of softTaskIntervals || []) {
      const id = Number(t.display_id);
      if (out.has(id)) continue;
      const depOn = t.depends_on_display_id != null ? Number(t.depends_on_display_id) : null;
      if (depOn == null || !out.has(depOn)) continue;
      const blocker = out.get(depOn);
      out.set(id, {
        display_id: id,
        title: t.summary,
        task_start: new Date(t.startMs).toISOString(),
        task_end: new Date(t.endMs).toISOString(),
        duration_min: Math.max(15, Math.round((t.endMs - t.startMs) / 60000)),
        habit_id: blocker.habit_id,
        habit_title: blocker.habit_title,
        habit_day: blocker.habit_day,
        habit_start: blocker.habit_start,
        habit_end: blocker.habit_end,
        reason: `pulled_with_blocker_MC-${depOn}`,
        depends_on_display_id: depOn,
        calendar_event_id: t.calendar_event_id,
      });
      grew = true;
    }
  }
  return [...out.values()];
}

function findSharedCalendarEventFlags(softTaskIntervals) {
  const byEvent = new Map();
  for (const t of softTaskIntervals || []) {
    const eid = t.calendar_event_id;
    if (!eid) continue;
    if (!byEvent.has(eid)) byEvent.set(eid, []);
    byEvent.get(eid).push(Number(t.display_id));
  }
  const flags = [];
  for (const [eid, ids] of byEvent) {
    if (ids.length < 2) continue;
    flags.push({
      calendar_event_id: eid,
      display_ids: ids,
      summary: `Shared calendar_event_id ${eid} on MC-${ids.join(' + MC-')} — split before apply`,
    });
  }
  return flags;
}

/** Habits outrank unpinned tasks — report overlaps as bumps (task yields). */
function findTaskBumps(placements, softTaskIntervals) {
  const bumps = [];
  for (const task of softTaskIntervals || []) {
    for (const p of placements || []) {
      if (overlaps(Date.parse(p.startIso), Date.parse(p.endIso), task.startMs, task.endMs)) {
        bumps.push({
          display_id: task.display_id,
          title: task.summary,
          task_start: new Date(task.startMs).toISOString(),
          task_end: new Date(task.endMs).toISOString(),
          duration_min: Math.max(15, Math.round((task.endMs - task.startMs) / 60000)),
          habit_id: p.habit_id,
          habit_title: p.title,
          habit_day: p.day,
          habit_start: p.startIso,
          habit_end: p.endIso,
          reason: 'habit_overlap',
          depends_on_display_id: task.depends_on_display_id,
          calendar_event_id: task.calendar_event_id,
        });
        break;
      }
    }
  }
  return expandBumpsWithDependents(bumps, softTaskIntervals);
}

/** Soft tasks whose slot already ended — still open, not assumed done. */
function findPastIncompleteTaskBumps(softTaskIntervals, nowMs = Date.now()) {
  const bumps = [];
  for (const task of softTaskIntervals || []) {
    if (task.slot_pinned) continue;
    if (!(task.endMs < nowMs)) continue;
    bumps.push({
      display_id: task.display_id,
      title: task.summary,
      task_start: new Date(task.startMs).toISOString(),
      task_end: new Date(task.endMs).toISOString(),
      duration_min: Math.max(15, Math.round((task.endMs - task.startMs) / 60000)),
      habit_id: null,
      habit_title: 'past incomplete slot',
      habit_day: isoToLondonDate(new Date(nowMs).toISOString()),
      habit_start: null,
      habit_end: null,
      reason: 'past_slot_incomplete',
      depends_on_display_id: task.depends_on_display_id,
      calendar_event_id: task.calendar_event_id,
    });
  }
  return expandBumpsWithDependents(bumps, softTaskIntervals);
}

/** Soft tasks sitting on rest/away/teaching blocked days. */
function findBlockedDayTaskBumps(softTaskIntervals, blockedSpans) {
  const bumps = [];
  for (const task of softTaskIntervals || []) {
    const day = isoToLondonDate(new Date(task.startMs).toISOString());
    if (!day || !dayBlockedForPlacement(day, blockedSpans)) continue;
    bumps.push({
      display_id: task.display_id,
      title: task.summary,
      task_start: new Date(task.startMs).toISOString(),
      task_end: new Date(task.endMs).toISOString(),
      duration_min: Math.max(15, Math.round((task.endMs - task.startMs) / 60000)),
      habit_id: null,
      habit_title: 'blocked day',
      habit_day: day,
      habit_start: null,
      habit_end: null,
      reason: 'on_blocked_day',
      depends_on_display_id: task.depends_on_display_id,
      calendar_event_id: task.calendar_event_id,
    });
  }
  return bumps;
}

/** Soft tasks overlapping travel-out → travel-back busy interval (edge days). */
function findAwayIntervalTaskBumps(softTaskIntervals, awaySpans) {
  const bumps = [];
  for (const task of softTaskIntervals || []) {
    const hit = (awaySpans || []).find((s) => s.kind === 'away_span'
      && Number.isFinite(s.startMs) && Number.isFinite(s.endMs)
      && overlaps(task.startMs, task.endMs, s.startMs, s.endMs));
    if (!hit) continue;
    const day = isoToLondonDate(new Date(task.startMs).toISOString());
    if (day && dayBlockedForPlacement(day, awaySpans)) continue;
    bumps.push({
      display_id: task.display_id,
      title: task.summary,
      task_start: new Date(task.startMs).toISOString(),
      task_end: new Date(task.endMs).toISOString(),
      duration_min: Math.max(15, Math.round((task.endMs - task.startMs) / 60000)),
      habit_id: null,
      habit_title: 'away interval',
      habit_day: day,
      habit_start: null,
      habit_end: null,
      reason: 'during_away',
      depends_on_display_id: task.depends_on_display_id,
      calendar_event_id: task.calendar_event_id,
    });
  }
  return bumps;
}

/** Adjacent soft tasks with gap < admin/decompress need — bump the later one. */
function findAdminGapTaskBumps(softTaskIntervals, ruleMap) {
  const byDay = new Map();
  for (const t of softTaskIntervals || []) {
    const day = isoToLondonDate(new Date(t.startMs).toISOString());
    if (!day) continue;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(t);
  }
  const bumps = [];
  const seen = new Set();
  for (const [day, list] of byDay) {
    list.sort((a, b) => a.startMs - b.startMs);
    for (let i = 0; i < list.length - 1; i += 1) {
      const a = list[i];
      const b = list[i + 1];
      const gap = (b.startMs - a.endMs) / 60000;
      const need = requiredGapMins(a.summary || '', b.summary || '', ruleMap);
      if (gap >= need) continue;
      if (seen.has(Number(b.display_id))) continue;
      seen.add(Number(b.display_id));
      bumps.push({
        display_id: b.display_id,
        title: b.summary,
        task_start: new Date(b.startMs).toISOString(),
        task_end: new Date(b.endMs).toISOString(),
        duration_min: Math.max(15, Math.round((b.endMs - b.startMs) / 60000)),
        habit_id: null,
        habit_title: `MC-${a.display_id}`,
        habit_day: day,
        habit_start: new Date(a.startMs).toISOString(),
        habit_end: new Date(a.endMs).toISOString(),
        reason: `admin_gap_${gap}m_need_${need}m`,
        depends_on_display_id: b.depends_on_display_id,
        calendar_event_id: b.calendar_event_id,
      });
    }
  }
  return bumps;
}

/** Unpinned soft tasks ending after working window — bump. */
function findAfterHoursTaskBumps(softTaskIntervals, ruleMap) {
  const bumps = [];
  for (const t of softTaskIntervals || []) {
    if (t.slot_pinned) continue;
    const day = isoToLondonDate(new Date(t.startMs).toISOString());
    if (!day) continue;
    const win = workingWindow(ruleMap, day);
    const endMin = isoToLondonMinutes(new Date(t.endMs).toISOString());
    if (endMin == null || endMin <= win.end_min) continue;
    bumps.push({
      display_id: t.display_id,
      title: t.summary,
      task_start: new Date(t.startMs).toISOString(),
      task_end: new Date(t.endMs).toISOString(),
      duration_min: Math.max(15, Math.round((t.endMs - t.startMs) / 60000)),
      habit_id: null,
      habit_title: 'after_hours',
      habit_day: day,
      habit_start: null,
      habit_end: null,
      reason: 'after_working_hours',
      depends_on_display_id: t.depends_on_display_id,
      calendar_event_id: t.calendar_event_id,
    });
  }
  return bumps;
}

/** Soft tasks overlapping each other — bump the higher display_id. */
function findSoftOverlapBumps(softTaskIntervals) {
  const sorted = [...(softTaskIntervals || [])]
    .sort((a, b) => Number(a.display_id) - Number(b.display_id));
  const seen = new Set();
  const bumps = [];
  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      const a = sorted[i];
      const b = sorted[j];
      if (!overlaps(a.startMs, a.endMs, b.startMs, b.endMs)) continue;
      const id = Number(b.display_id);
      if (seen.has(id)) continue;
      seen.add(id);
      const day = isoToLondonDate(new Date(b.startMs).toISOString());
      bumps.push({
        display_id: id,
        title: b.summary,
        task_start: new Date(b.startMs).toISOString(),
        task_end: new Date(b.endMs).toISOString(),
        duration_min: Math.max(15, Math.round((b.endMs - b.startMs) / 60000)),
        habit_id: null,
        habit_title: `MC-${a.display_id}`,
        habit_day: day,
        habit_start: new Date(a.startMs).toISOString(),
        habit_end: new Date(a.endMs).toISOString(),
        reason: 'task_overlap',
        depends_on_display_id: b.depends_on_display_id,
        calendar_event_id: b.calendar_event_id,
      });
    }
  }
  return bumps;
}

function mergeTaskBumps(...lists) {
  const byId = new Map();
  for (const list of lists) {
    for (const b of list || []) {
      const id = Number(b.display_id);
      if (!byId.has(id)) byId.set(id, b);
    }
  }
  return [...byId.values()];
}

function orderBumpsByTaskDeps(bumps, softTaskIntervals) {
  const byId = new Map((softTaskIntervals || []).map((t) => [Number(t.display_id), t]));
  const bumpById = new Map((bumps || []).map((b) => [Number(b.display_id), b]));
  const incoming = new Map([...bumpById.keys()].map((id) => [id, 0]));
  const outs = new Map([...bumpById.keys()].map((id) => [id, []]));
  for (const id of bumpById.keys()) {
    const dep = byId.get(id)?.depends_on_display_id;
    if (dep == null || !bumpById.has(Number(dep))) continue;
    outs.get(Number(dep)).push(id);
    incoming.set(id, (incoming.get(id) || 0) + 1);
  }
  const ready = [...bumpById.keys()].filter((id) => (incoming.get(id) || 0) === 0)
    .sort((a, b) => a - b);
  const ordered = [];
  while (ready.length) {
    const id = ready.shift();
    ordered.push(bumpById.get(id));
    for (const child of outs.get(id) || []) {
      incoming.set(child, incoming.get(child) - 1);
      if (incoming.get(child) === 0) ready.push(child);
    }
    ready.sort((a, b) => a - b);
  }
  for (const b of bumps || []) {
    if (!ordered.includes(b)) ordered.push(b);
  }
  return ordered;
}

/**
 * Place each bumped task into a concrete gap (never "pick a slot").
 * Respects depends_on_display_id: dependents start after blockers' new end.
 */
function placeBumpedTasks(bumps, softTaskIntervals, hardBusy, placements, ruleMap, holidays, fromYmd) {
  const bumpedIds = new Set((bumps || []).map((b) => Number(b.display_id)));
  const softById = new Map((softTaskIntervals || []).map((t) => [Number(t.display_id), t]));
  const placedBlocks = (placements || []).map((p) => ({
    day: p.day,
    startIso: p.startIso,
    endIso: p.endIso,
    title: p.title,
  }));
  const dayUsed = {};
  for (const p of placements || []) {
    dayUsed[p.day] = (dayUsed[p.day] || 0) + (p.duration_min || 0);
  }

  const occupying = (softTaskIntervals || [])
    .filter((t) => !bumpedIds.has(Number(t.display_id)))
    .map((t) => ({ startMs: t.startMs, endMs: t.endMs, summary: t.summary }));
  seedDayUsed(dayUsed, hardBusy || [], fromYmd, null);
  seedDayUsed(dayUsed, occupying, fromYmd, null);

  const busyBase = (hardBusy || []).concat(occupying);
  for (const p of placements || []) {
    busyBase.push({
      startMs: Date.parse(p.startIso),
      endMs: Date.parse(p.endIso),
      summary: p.title,
    });
  }

  const scheduled = [];
  const unplaced = [];
  const ordered = orderBumpsByTaskDeps(bumps, softTaskIntervals);

  for (const bump of ordered) {
    const durationMin = bump.duration_min || 30;
    const title = String(bump.title || `MC-${bump.display_id}`).replace(/^MC-\d+\s*/, '')
      || `MC-${bump.display_id}`;
    const soft = softById.get(Number(bump.display_id));
    const depOn = soft?.depends_on_display_id != null
      ? Number(soft.depends_on_display_id)
      : (bump.depends_on_display_id != null ? Number(bump.depends_on_display_id) : null);
    const blocker = depOn != null
      ? scheduled.find((s) => Number(s.display_id) === depOn)
      : null;
    const notBeforeMs = blocker ? Date.parse(blocker.new_end) : null;
    const notBeforeDay = blocker ? blocker.new_day : null;

    const idealHm = (() => {
      try {
        return hmLabel(isoToLondonMinutes(bump.task_start));
      } catch (e) {
        return '10:00';
      }
    })();
    const awaySpans = (hardBusy || []).filter((b) => b.kind === 'away_span'
      || b.kind === 'teaching_day'
      || b.kind === 'rest_after_workshop'
      || b.restDay);
    const startDay = notBeforeDay || bump.habit_day || fromYmd;
    const days = [];
    for (let i = 0; i <= 14; i += 1) {
      const d = addDays(startDay, i);
      if (d >= fromYmd && isSchedulableDay(d, ruleMap, holidays)
        && !dayBlockedForPlacement(d, awaySpans)) days.push(d);
    }

    let slot = null;
    const busyWork = busyBase.concat(
      scheduled.map((s) => ({
        startMs: Date.parse(s.new_start),
        endMs: Date.parse(s.new_end),
        summary: s.title,
      })),
    );
    const placedWork = placedBlocks.concat(
      scheduled.map((s) => ({
        day: s.new_day,
        startIso: s.new_start,
        endIso: s.new_end,
        title: s.title,
      })),
    );

    for (const day of days) {
      const trial = trySlotOnDay(
        day, durationMin, idealHm, title, busyWork, placedWork, dayUsed, ruleMap,
      );
      if (!trial) continue;
      if (notBeforeMs != null && Date.parse(trial.startIso) < notBeforeMs) continue;
      slot = trial;
      break;
    }

    if (!slot) {
      unplaced.push({
        ...bump,
        depends_on_display_id: depOn,
        unplaced: true,
        reason: depOn != null
          ? `UNPLACED — no slot after blocker MC-${depOn} within 14 days`
          : 'UNPLACED — no legal gap within 14 days under cap/window/gaps',
      });
      continue;
    }

    dayUsed[slot.day] = (dayUsed[slot.day] || 0) + durationMin;
    scheduled.push({
      ...bump,
      title,
      depends_on_display_id: depOn,
      new_day: slot.day,
      new_start: slot.startIso,
      new_end: slot.endIso,
      duration_min: durationMin,
      unplaced: false,
    });
  }

  return { scheduled, unplaced, shared_calendar_flags: findSharedCalendarEventFlags(softTaskIntervals) };
}

/** Blockers before dependents; among peers, hardest-first (p0→p5). */
function orderHabitsForPlacement(habits, deps) {
  const byId = new Map(habits.map((h) => [h.id, h]));
  const incoming = new Map(habits.map((h) => [h.id, 0]));
  const outs = new Map(habits.map((h) => [h.id, []]));
  for (const d of deps || []) {
    if (!byId.has(d.habit_id) || !byId.has(d.depends_on_habit_id)) continue;
    outs.get(d.depends_on_habit_id).push(d.habit_id);
    incoming.set(d.habit_id, (incoming.get(d.habit_id) || 0) + 1);
  }
  const byPri = (a, b) => priorityRank(a.priority) - priorityRank(b.priority)
    || String(a.title || '').localeCompare(String(b.title || ''));
  const ready = habits.filter((h) => (incoming.get(h.id) || 0) === 0).sort(byPri);
  const ordered = [];
  while (ready.length) {
    const h = ready.shift();
    ordered.push(h);
    for (const child of outs.get(h.id) || []) {
      incoming.set(child, incoming.get(child) - 1);
      if (incoming.get(child) === 0) {
        ready.push(byId.get(child));
        ready.sort(byPri);
      }
    }
  }
  for (const h of habits) {
    if (!ordered.includes(h)) ordered.push(h);
  }
  return ordered;
}

/** First schedulable non-blocked day on/after ymd (skips chained away/rest). */
function firstOpenOnOrAfter(ymd, ruleMap, holidays, awaySpans, maxSteps = 14, forHabits = false) {
  const blockedFn = forHabits ? dayBlockedForHabits : dayBlockedForPlacement;
  let d = ymd;
  for (let i = 0; i < maxSteps; i += 1) {
    if (isSchedulableDay(d, ruleMap, holidays) && !blockedFn(d, awaySpans)) return d;
    d = addDays(d, 1);
  }
  return null;
}

function candidateDays(idealYmd, windowDays, timeCritical, ruleMap, holidays, awaySpans = [], rrule = '', forHabits = false) {
  const blockedFn = forHabits ? dayBlockedForHabits : dayBlockedForPlacement;
  const w = Math.max(0, Number(windowDays) || 0);
  const mode = criticalRollMode(rrule, timeCritical === true);
  const days = [];
  const cover = coveringBlockedSpan(idealYmd, awaySpans)
    || (forHabits && dayBlockedForHabits(idealYmd, awaySpans)
      ? (awaySpans || []).find((s) => dayBlockedForHabits(idealYmd, [s]))
      : null);
  // Ideal on away / rest / teaching → jump past the whole blocked run.
  if (cover) {
    const after = addDays(cover.restDay || cover.endDay, 1);
    const before = addDays(cover.startDay, -1);
    if (mode === 'forward') {
      const open = firstOpenOnOrAfter(
        after >= idealYmd ? after : idealYmd, ruleMap, holidays, awaySpans, 14, forHabits,
      );
      if (open) days.push(open);
    } else if (mode === 'backward') {
      if (before <= idealYmd) days.push(before);
    } else {
      days.push(before, after);
      const open = firstOpenOnOrAfter(after, ruleMap, holidays, awaySpans, 14, forHabits);
      if (open) days.push(open);
    }
  }
  if (mode === 'forward') {
    for (let i = 0; i <= w; i += 1) days.push(addDays(idealYmd, i));
  } else if (mode === 'backward') {
    for (let i = 0; i <= w; i += 1) days.push(addDays(idealYmd, -i));
  } else {
    days.push(idealYmd);
    for (let i = 1; i <= w; i += 1) {
      days.push(addDays(idealYmd, i));
      days.push(addDays(idealYmd, -i));
    }
  }
  return [...new Set(days)].filter((d) => {
    if (mode === 'forward' && d < idealYmd) return false;
    if (mode === 'backward' && d > idealYmd) return false;
    return isSchedulableDay(d, ruleMap, holidays) && !blockedFn(d, awaySpans);
  });
}

/** Admin ticks get admin_gap_min; substantial (incl. Publish Blog) get decompress_after_task_min. */
function habitGapTier(title) {
  const t = String(title || '').toLowerCase();
  if (/publish\s+blog/.test(t)) return 'substantial';
  const admin = [
    /joining details/,
    /hotel bookings/,
    /booking sheet/,
    /bau global/,
    /upload sites/,
    /seo performance/,
    /monthly accounts/,
    /artfully walls/,
    /backup photos/,
    /review\/amend course/,
    /update event schema/,
    /light and logic/,
  ];
  if (admin.some((re) => re.test(t))) return 'admin';
  return 'substantial';
}

function gapMinsForTitle(title, ruleMap) {
  if (habitGapTier(title) === 'admin') return Number(ruleMap.admin_gap_min || 15);
  return Number(ruleMap.decompress_after_task_min || 30);
}

/** Gap either side = max(after prev, before next). Never allow zero-gap stacking. */
function requiredGapMins(prevTitle, nextTitle, ruleMap) {
  return Math.max(gapMinsForTitle(prevTitle, ruleMap), gapMinsForTitle(nextTitle, ruleMap));
}

function decompressOk(startMs, endMs, title, placed, ruleMap) {
  const day = isoToLondonDate(new Date(startMs).toISOString());
  for (const p of placed) {
    if (p.day !== day) continue;
    const ps = Date.parse(p.startIso);
    const pe = Date.parse(p.endIso);
    if (overlaps(startMs, endMs, ps, pe)) return false;
    const need = requiredGapMins(p.title, title, ruleMap);
    if (pe <= startMs && (startMs - pe) / 60000 < need) return false;
    if (endMs <= ps && (ps - endMs) / 60000 < need) return false;
  }
  return true;
}

/** Busy intervals (tasks/events) as decompress neighbors — skip away/rest banners. */
function busyAsGapNeighbors(busy, day) {
  const out = [];
  for (const b of busy || []) {
    if (b.kind === 'away_span' || b.kind === 'teaching_day' || b.kind === 'rest_after_workshop') continue;
    const title = b.summary || b.title;
    if (!title) continue;
    const bd = isoToLondonDate(new Date(b.startMs).toISOString());
    if (bd !== day) continue;
    out.push({
      day: bd,
      startIso: new Date(b.startMs).toISOString(),
      endIso: new Date(b.endMs).toISOString(),
      title,
    });
  }
  return out;
}

function seedDayUsed(dayUsed, intervals, fromYmd, toYmd) {
  for (const b of intervals || []) {
    if (b.kind === 'away_span' || b.kind === 'teaching_day' || b.kind === 'rest_after_workshop') continue;
    if (!Number.isFinite(b.startMs) || !Number.isFinite(b.endMs)) continue;
    const day = isoToLondonDate(new Date(b.startMs).toISOString());
    if (!day || (fromYmd && day < fromYmd) || (toYmd && day > toYmd)) continue;
    dayUsed[day] = (dayUsed[day] || 0) + Math.max(0, Math.round((b.endMs - b.startMs) / 60000));
  }
}

function trySlotOnDay(day, durationMin, idealHm, title, busy, placed, dayUsed, ruleMap) {
  const win = workingWindow(ruleMap, day);
  const { hard } = dayCapLimits(ruleMap);
  if ((dayUsed[day] || 0) + durationMin > hard) return null;

  const idealMin = parseHm(idealHm);
  const starts = [];
  for (let m = idealMin; m + durationMin <= win.end_min; m += 15) starts.push(m);
  for (let m = idealMin - 15; m >= win.start_min; m -= 15) starts.push(m);

  const neighbors = (placed || []).concat(busyAsGapNeighbors(busy, day));
  for (const startMin of starts) {
    if (startMin < win.start_min || startMin + durationMin > win.end_min) continue;
    const startMs = londonYmdHmToUtcMs(day, hmLabel(startMin));
    const endMs = londonYmdHmToUtcMs(day, hmLabel(startMin + durationMin));
    if (busy.some((b) => overlaps(startMs, endMs, b.startMs, b.endMs))) continue;
    if (!decompressOk(startMs, endMs, title, neighbors, ruleMap)) continue;
    return {
      day,
      startIso: new Date(startMs).toISOString(),
      endIso: new Date(endMs).toISOString(),
      durationMin,
    };
  }
  return null;
}

function depOk(habit, slot, placedByHabit, deps) {
  for (const d of (deps || []).filter((x) => x.habit_id === habit.id)) {
    const blockers = placedByHabit.get(d.depends_on_habit_id) || [];
    const hit = blockers.some((b) => {
      if (d.dep_type === 'must_complete_first') return b.day <= slot.day;
      if (d.dep_type === 'same_day_after') {
        return b.day === slot.day && Date.parse(b.endIso) <= Date.parse(slot.startIso);
      }
      if (d.dep_type === 'within_hours') {
        const hrs = Number(d.within_hours) || 24;
        return Date.parse(b.endIso) <= Date.parse(slot.startIso)
          && (Date.parse(slot.startIso) - Date.parse(b.endIso)) / 3600000 <= hrs;
      }
      return true;
    });
    if (!hit) return false;
  }
  return true;
}

function placeHabits(habits, deps, busy, ruleMap, holidays, fromYmd, toYmd, opts = {}) {
  const ordered = orderHabitsForPlacement(habits, deps);
  const placements = [];
  const unplaced = [];
  const dayUsed = {};
  seedDayUsed(dayUsed, busy, fromYmd, toYmd);
  seedDayUsed(dayUsed, opts.softTaskIntervals || [], fromYmd, toYmd);
  const placedByHabit = new Map();
  const busyWork = busy.slice();
  const awaySpans = (busy || []).filter((b) => b.kind === 'away_span'
    || b.kind === 'teaching_day'
    || b.kind === 'rest_after_workshop'
    || b.restDay);
  // opts.existingHabitIntervals must already be merged into `busy` with habit_id + ideal_date
  // so self-strip below can KEEP/MOVE an occurrence without colliding with itself.

  for (const habit of ordered) {
    for (const ideal of occurrencesInRange(habit.rrule, fromYmd, toYmd, 200)) {
      const days = candidateDays(
        ideal, habit.window_days, habit.time_critical === true, ruleMap, holidays, awaySpans,
        habit.rrule, true,
      );
      // While re-placing this occurrence, ignore its own prior block so it can KEEP/MOVE.
      // existingHabitIntervals are already seeded into busyWork (with habit_id/ideal_date).
      const busySansSelf = busyWork
        .filter((b) => !(b.habit_id === habit.id && b.ideal_date === ideal));
      let slot = null;
      for (const day of days) {
        if (dayBlockedForHabits(day, awaySpans)) continue;
        const trial = trySlotOnDay(
          day, Number(habit.duration_min) || 60, habit.ideal_time || '09:00',
          habit.title, busySansSelf, placements, dayUsed, ruleMap,
        );
        if (!trial || !depOk(habit, trial, placedByHabit, deps)) continue;
        slot = trial;
        break;
      }
      if (!slot) {
        unplaced.push({ habit_id: habit.id, title: habit.title, ideal_date: ideal });
        continue;
      }
      const row = {
        habit_id: habit.id,
        title: habit.title,
        priority: habit.priority,
        ideal_date: ideal,
        day: slot.day,
        startIso: slot.startIso,
        endIso: slot.endIso,
        duration_min: slot.durationMin,
      };
      placements.push(row);
      dayUsed[slot.day] = (dayUsed[slot.day] || 0) + slot.durationMin;
      if (!placedByHabit.has(habit.id)) placedByHabit.set(habit.id, []);
      placedByHabit.get(habit.id).push(row);
      busyWork.push({
        startMs: Date.parse(slot.startIso),
        endMs: Date.parse(slot.endIso),
        summary: habit.title,
        habit_id: habit.id,
        ideal_date: ideal,
      });
    }
  }
  cullPackedDayPlacements(placements, unplaced, dayUsed, ruleMap);
  return { placements, unplaced };
}

/** Final pass: drop lower-priority / later placements that still gap/overlap. */
function cullPackedDayPlacements(placements, unplaced, dayUsed, ruleMap) {
  const kept = [];
  const sorted = placements.slice().sort((a, b) => {
    const pr = priorityRank(a.priority) - priorityRank(b.priority);
    if (pr !== 0) return pr;
    return Date.parse(a.startIso) - Date.parse(b.startIso);
  });
  for (const p of sorted) {
    const aS = Date.parse(p.startIso);
    const aE = Date.parse(p.endIso);
    const conflict = kept.some((k) => {
      if (k.day !== p.day) return false;
      const kS = Date.parse(k.startIso);
      const kE = Date.parse(k.endIso);
      if (overlaps(aS, aE, kS, kE)) return true;
      const gap = aE <= kS ? (kS - aE) / 60000 : (aS - kE) / 60000;
      if (gap < 0) return true;
      return gap < requiredGapMins(k.title, p.title, ruleMap);
    });
    if (conflict) {
      unplaced.push({
        habit_id: p.habit_id, title: p.title, ideal_date: p.ideal_date,
        reason: 'cull_overlap_gap',
      });
      continue;
    }
    kept.push(p);
  }
  placements.length = 0;
  for (const p of kept) placements.push(p);
}

function sameLondonSlot(aIso, bIso) {
  if (!aIso || !bIso) return false;
  return isoToLondonDate(aIso) === isoToLondonDate(bIso)
    && isoToLondonMinutes(aIso) === isoToLondonMinutes(bIso);
}

function buildAmendments(placements, existing = [], fromYmd = null) {
  const key = (r) => `${r.habit_id}|${r.ideal_date}`;
  const plan = new Map(placements.map((p) => [key(p), p]));
  const have = new Map(existing.map((e) => [key(e), e]));
  const out = [];
  for (const [k, p] of plan) {
    const e = have.get(k);
    if (!e) {
      out.push({
        action: 'CREATE', habit_id: p.habit_id, title: p.title,
        ideal_date: p.ideal_date, startIso: p.startIso, endIso: p.endIso,
      });
      continue;
    }
    const same = sameLondonSlot(e.startIso, p.startIso) && sameLondonSlot(e.endIso, p.endIso);
    // Placed in DB but no Google link → must CREATE (KEEP previously hid this hole).
    if (same && !e.calendar_event_id) {
      out.push({
        action: 'CREATE',
        habit_id: p.habit_id,
        title: p.title,
        ideal_date: p.ideal_date,
        startIso: p.startIso,
        endIso: p.endIso,
      });
      continue;
    }
    out.push({
      action: same ? 'KEEP' : 'MOVE',
      habit_id: p.habit_id,
      title: p.title,
      ideal_date: p.ideal_date,
      startIso: p.startIso,
      endIso: p.endIso,
      calendar_event_id: e.calendar_event_id,
      ...(same ? {} : { from_startIso: e.startIso, from_endIso: e.endIso }),
    });
  }
  for (const [k, e] of have) {
    if (plan.has(k)) continue;
    out.push({
      action: 'DELETE', habit_id: e.habit_id, title: e.title,
      ideal_date: e.ideal_date, startIso: e.startIso, endIso: e.endIso,
      calendar_event_id: e.calendar_event_id,
    });
  }
  if (!fromYmd) return out;
  // Never drop DELETE that still has a live calendar_event_id — past days must still unplace Google.
  return out.filter((a) => {
    if (a.action === 'DELETE' && a.calendar_event_id) return true;
    const day = isoToLondonDate(a.startIso) || a.ideal_date;
    return day >= fromYmd;
  });
}

function provePlacement(placements, clientBusy, deps, ruleMap, opts = {}) {
  const fails = [];
  const { hard } = dayCapLimits(ruleMap);
  const dayUsed = {};
  const softTasks = opts.softTaskIntervals || [];
  const bumps = opts.bumps || findTaskBumps(placements, softTasks);
  const bumpedIds = new Set(bumps.map((b) => Number(b.display_id)));

  // Cap includes soft tasks that remain (not bumped) — packed days must not exceed hard.
  // Do NOT seed away/rest banners or multi-day busy spans into the cap meter.
  seedDayUsed(dayUsed, softTasks.filter((t) => !bumpedIds.has(Number(t.display_id))), null, null);

  for (let i = 0; i < placements.length; i += 1) {
    const a = placements[i];
    const aS = Date.parse(a.startIso);
    const aE = Date.parse(a.endIso);
    dayUsed[a.day] = (dayUsed[a.day] || 0) + a.duration_min;
    for (const b of clientBusy) {
      // Existing habit intervals are seeded into busy for placement; do not fail
      // proof against the same occurrence (habit_id|ideal_date).
      if (b.habit_id && b.ideal_date
        && b.habit_id === a.habit_id && b.ideal_date === a.ideal_date) {
        continue;
      }
      if (overlaps(aS, aE, b.startMs, b.endMs)) {
        fails.push(`habit-client: ${a.title} @ ${a.day}`);
      }
    }
    for (const t of softTasks) {
      if (!overlaps(aS, aE, t.startMs, t.endMs)) continue;
      if (!bumpedIds.has(Number(t.display_id))) {
        fails.push(`habit-task-silent: ${a.title} × MC-${t.display_id}`);
      }
    }
    for (let j = i + 1; j < placements.length; j += 1) {
      const o = placements[j];
      const oS = Date.parse(o.startIso);
      const oE = Date.parse(o.endIso);
      if (overlaps(aS, aE, oS, oE)) {
        fails.push(`habit-habit: ${a.title} × ${o.title}`);
      }
      if (a.day !== o.day) continue;
      const gap = aE <= oS ? (oS - aE) / 60000 : (aS - oE) / 60000;
      if (gap < 0) continue;
      const need = requiredGapMins(a.title, o.title, ruleMap);
      if (gap < need) {
        fails.push(`gap: ${a.day} ${a.title} ↔ ${o.title} ${gap}m < ${need}m`);
      }
    }
  }
  for (const [day, mins] of Object.entries(dayUsed)) {
    if (mins > hard) fails.push(`cap: ${day} ${mins}m > ${hard}m`);
  }
  for (const d of deps || []) {
    const depsRows = placements.filter((p) => p.habit_id === d.habit_id);
    const blockers = placements.filter((p) => p.habit_id === d.depends_on_habit_id);
    for (const dep of depsRows) {
      if (!depOk({ id: d.habit_id }, dep, new Map([[d.depends_on_habit_id, blockers]]), [d])) {
        fails.push(`dep: ${dep.title} ${d.dep_type}`);
      }
    }
  }
  return { ok: fails.length === 0, fails, bumps };
}

module.exports = {
  londonYmdHmToUtcMs,
  buildBusyIntervals,
  awaySpansFromTravelBlocks,
  restDayRuleEnabled,
  restDaySpansFromWorkshopEvents,
  multidayWorkshopRestRows,
  workshopEventDayRange,
  isWorkshopCalendarEvent,
  isRestDaySourceEvent,
  dayInsideAwaySpan,
  dayBlockedForPlacement,
  dayBlockedForHabits,
  restDaySpansFromDbRows,
  coveringBlockedSpan,
  awayBusySegments,
  partialAwayMinsOnDay,
  intervalInsideAwaySpan,
  teachingDayRuleEnabled,
  teachingDaySpansFromEvents,
  datedTasksToIntervals,
  findTaskBumps,
  findBlockedDayTaskBumps,
  findAwayIntervalTaskBumps,
  findAdminGapTaskBumps,
  findAfterHoursTaskBumps,
  findPastIncompleteTaskBumps,
  findSoftOverlapBumps,
  mergeTaskBumps,
  placeBumpedTasks,
  findSharedCalendarEventFlags,
  orderHabitsForPlacement,
  placeHabits,
  buildAmendments,
  provePlacement,
  candidateDays,
  criticalRollMode,
  dayCapLimits,
  habitGapTier,
  gapMinsForTitle,
  requiredGapMins,
  sameLondonSlot,
  trySlotOnDay,
};
