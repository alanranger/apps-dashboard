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

function candidateDays(idealYmd, windowDays, timeCritical, ruleMap, holidays) {
  const w = Math.max(0, Number(windowDays) || 0);
  const days = [];
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
  return [...new Set(days)].filter((d) => isSchedulableDay(d, ruleMap, holidays));
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

  for (const habit of ordered) {
    for (const ideal of occurrencesInRange(habit.rrule, fromYmd, toYmd, 200)) {
      const days = candidateDays(
        ideal, habit.window_days, habit.time_critical === true, ruleMap, holidays,
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

function buildAmendments(placements, existing = []) {
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
    const same = Date.parse(e.startIso) === Date.parse(p.startIso)
      && Date.parse(e.endIso) === Date.parse(p.endIso);
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
  return out;
}

function provePlacement(placements, clientBusy, deps, ruleMap) {
  const fails = [];
  const { hard } = dayCapLimits(ruleMap);
  const dayUsed = {};
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
  return { ok: fails.length === 0, fails };
}

module.exports = {
  londonYmdHmToUtcMs,
  buildBusyIntervals,
  orderHabitsForPlacement,
  placeHabits,
  buildAmendments,
  provePlacement,
  candidateDays,
  dayCapLimits,
  habitGapTier,
  gapMinsForTitle,
  requiredGapMins,
};
