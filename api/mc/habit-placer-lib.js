/**
 * Joint habit placer (offline spike) — pure, no Calendar writes.
 * Busy map frozen first → habits by dep-topology then hardest-first → amendments.
 */
const {
  workingWindow, isSchedulableDay, isoToLondonDate, isoToLondonMinutes, addDays,
} = require('./scheduling-rules-lib');
const { occurrencesInRange } = require('./rrule-core');
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
 * Hard-busy whole London days out→back (incl. travel days + middle).
 * Same-day day-trips skipped (drive intervals already cover those).
 * Pair by workshop_row_key or venue|workshop_start; else next unused back.
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
    spans.push({
      startDay,
      endDay,
      startMs: londonYmdHmToUtcMs(startDay, '00:00'),
      endMs: londonYmdHmToUtcMs(endDay, '23:59') + 60000,
      summary: `away:${out.venue_name || out.workshop_title || key}`,
      kind: 'away_span',
    });
  }
  return spans.sort((a, b) => a.startMs - b.startMs);
}

function dayInsideAwaySpan(day, spans) {
  return (spans || []).some((s) => day >= s.startDay && day <= s.endDay);
}

/**
 * Busy intervals from mixed events. Strip MC (incl. MC ⚽).
 * Ipswich force-busy expanded by fixture_buffer_min.
 */
function buildBusyIntervals(events, ruleMap = {}) {
  const buffer = Number(ruleMap.fixture_buffer_min || 60);
  const out = [];
  for (const e of events || []) {
    if (isMcBlock(e) || isFixtureBlock(e, ruleMap)) continue;
    const calId = e._calendarId || e.calendarId;
    const force = isForceBusyCalendar(calId);
    if (e.transparency === 'transparent' && !force) continue;

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
    if (force) {
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
          depends_on_display_id: task.depends_on_display_id,
          calendar_event_id: task.calendar_event_id,
        });
        break;
      }
    }
  }
  return expandBumpsWithDependents(bumps, softTaskIntervals);
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
    const awaySpans = (hardBusy || []).filter((b) => b.kind === 'away_span');
    const startDay = notBeforeDay || bump.habit_day || fromYmd;
    const days = [];
    for (let i = 0; i <= 14; i += 1) {
      const d = addDays(startDay, i);
      if (d >= fromYmd && isSchedulableDay(d, ruleMap, holidays)
        && !dayInsideAwaySpan(d, awaySpans)) days.push(d);
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

function candidateDays(idealYmd, windowDays, timeCritical, ruleMap, holidays, awaySpans = []) {
  const w = Math.max(0, Number(windowDays) || 0);
  const days = [];
  const cover = (awaySpans || []).find((s) => idealYmd >= s.startDay && idealYmd <= s.endDay);
  // Ideal on an away day → jump past the whole span (before out / after back).
  if (cover) {
    days.push(addDays(cover.startDay, -1), addDays(cover.endDay, 1));
  }
  if (timeCritical) {
    for (let i = w; i >= 0; i -= 1) days.push(addDays(idealYmd, -i));
    for (let i = 1; i <= w; i += 1) days.push(addDays(idealYmd, i));
  } else {
    days.push(idealYmd);
    for (let i = 1; i <= w; i += 1) {
      days.push(addDays(idealYmd, i));
      days.push(addDays(idealYmd, -i));
    }
  }
  return [...new Set(days)].filter((d) => isSchedulableDay(d, ruleMap, holidays)
    && !dayInsideAwaySpan(d, awaySpans));
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

function trySlotOnDay(day, durationMin, idealHm, title, busy, placed, dayUsed, ruleMap) {
  const win = workingWindow(ruleMap, day);
  const { hard } = dayCapLimits(ruleMap);
  if ((dayUsed[day] || 0) + durationMin > hard) return null;

  const idealMin = parseHm(idealHm);
  const starts = [];
  for (let m = idealMin; m + durationMin <= win.end_min; m += 15) starts.push(m);
  for (let m = idealMin - 15; m >= win.start_min; m -= 15) starts.push(m);

  for (const startMin of starts) {
    if (startMin < win.start_min || startMin + durationMin > win.end_min) continue;
    const startMs = londonYmdHmToUtcMs(day, hmLabel(startMin));
    const endMs = londonYmdHmToUtcMs(day, hmLabel(startMin + durationMin));
    if (busy.some((b) => overlaps(startMs, endMs, b.startMs, b.endMs))) continue;
    if (!decompressOk(startMs, endMs, title, placed, ruleMap)) continue;
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

function placeHabits(habits, deps, busy, ruleMap, holidays, fromYmd, toYmd) {
  const ordered = orderHabitsForPlacement(habits, deps);
  const placements = [];
  const unplaced = [];
  const dayUsed = {};
  const placedByHabit = new Map();
  const busyWork = busy.slice();
  const awaySpans = (busy || []).filter((b) => b.kind === 'away_span');

  for (const habit of ordered) {
    for (const ideal of occurrencesInRange(habit.rrule, fromYmd, toYmd, 200)) {
      const days = candidateDays(
        ideal, habit.window_days, habit.time_critical === true, ruleMap, holidays, awaySpans,
      );
      let slot = null;
      for (const day of days) {
        const trial = trySlotOnDay(
          day, Number(habit.duration_min) || 60, habit.ideal_time || '09:00',
          habit.title, busyWork, placements, dayUsed, ruleMap,
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
      });
    }
  }
  return { placements, unplaced };
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
  return out.filter((a) => {
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

  for (let i = 0; i < placements.length; i += 1) {
    const a = placements[i];
    const aS = Date.parse(a.startIso);
    const aE = Date.parse(a.endIso);
    dayUsed[a.day] = (dayUsed[a.day] || 0) + a.duration_min;
    for (const b of clientBusy) {
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
  dayInsideAwaySpan,
  datedTasksToIntervals,
  findTaskBumps,
  placeBumpedTasks,
  findSharedCalendarEventFlags,
  orderHabitsForPlacement,
  placeHabits,
  buildAmendments,
  provePlacement,
  candidateDays,
  dayCapLimits,
  habitGapTier,
  gapMinsForTitle,
  requiredGapMins,
  sameLondonSlot,
};
