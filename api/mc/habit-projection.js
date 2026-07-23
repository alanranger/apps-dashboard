/**
 * BAU habit calendar projection from recurring_tasks (READ-ONLY — no Google Calendar).
 *
 * Expands each active habit's RRULE over a rolling horizon (default 90 days).
 * Claude reads this list, places events in Google Calendar, and POSTs back via
 * /api/mc/habit-scheduled. Never filters occurrences except active=false.
 */
const { envReady, json, cors, sb } = require('./_lib');
const {
  occurrencesInRange, fromYmd, addDays, toYmd, lastDueOnOrBefore,
} = require('./rrule-core');
const { PRIORITY_ORDER } = require('./priority-lib');
const { fetchCompetingPool, competitionForRange } = require('./competing-items-lib');

const DEFAULT_HORIZON = 90;
const MAX_HORIZON = 366;

function londonToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function fmtTime(t) {
  return String(t || '09:00').slice(0, 5);
}

/** Blocker cycle complete for this dependent occurrence? */
function cycleComplete(blocker, idealDate) {
  if (!blocker?.last_done) return false;
  let due = null;
  try { due = lastDueOnOrBefore(blocker.rrule, idealDate); } catch { due = null; }
  return due ? blocker.last_done >= due : true;
}

/** Per dep_type satisfaction (date-level; Claude applies slot-time for same_day_after / within_hours). */
function depSatisfied(dep, blocker, idealDate) {
  if (!blocker) return false;
  if (dep.dep_type === 'must_complete_first') return cycleComplete(blocker, idealDate);
  if (dep.dep_type === 'same_day_after') {
    return blocker.last_done ? blocker.last_done >= idealDate : false;
  }
  if (dep.dep_type === 'within_hours') {
    if (!cycleComplete(blocker, idealDate)) return false;
    const done = blocker.last_done;
    const windowEnd = toYmd(addDays(fromYmd(done), 1));
    return idealDate >= done && idealDate <= windowEnd;
  }
  return false;
}

function buildBlockedBy(deps, habitMap, idealDate) {
  return (deps || []).map((dep) => {
    const blocker = habitMap.get(dep.depends_on_habit_id);
    return {
      habit_id: dep.depends_on_habit_id,
      title: blocker ? blocker.title : '(unknown habit)',
      dep_type: dep.dep_type,
      within_hours: dep.within_hours ?? null,
      satisfied: depSatisfied(dep, blocker, idealDate),
      blocker_last_done: blocker ? (blocker.last_done || null) : null,
    };
  });
}

function placementForOccurrence(comp, kind, id) {
  const key = kind === 'task' ? 'task' : 'habit';
  const match = (row) => row.kind === key && String(row.id) === String(id);
  if ((comp.placed || []).some(match)) {
    return { placement: 'fits', roll_forward: false };
  }
  const displaced = (comp.displaced || []).find(match);
  if (displaced) {
    return {
      placement: 'displaced',
      roll_forward: true,
      displacement_reason: displaced.reason || 'lower_priority_than_cap',
    };
  }
  return { placement: 'fits', roll_forward: false };
}

module.exports = async function handler(req, res) {
  if (cors(req, res)) return;
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
  const today = londonToday();
  const reqDays = Number(req.query?.days);
  const horizon = Number.isFinite(reqDays) && reqDays > 0
    ? Math.min(Math.round(reqDays), MAX_HORIZON) : DEFAULT_HORIZON;
  if (!envReady()) {
    return json(res, 200, {
      configured: false, generated_at: new Date().toISOString(), today,
      timezone: 'Europe/London', horizon_days: horizon, count: 0, occurrences: [], calendar_writes: 0,
    });
  }
  try {
    const endYmd = toYmd(addDays(fromYmd(today), horizon));
    const [habits, allHabits, deps, pool, rules] = await Promise.all([
      sb('recurring_tasks?select=id,title,cadence_text,rrule,duration_min,ideal_time,window_days,priority,last_scheduled,last_done,rolls_used&active=eq.true&order=title.asc'),
      sb('recurring_tasks?select=id,title,rrule,last_done'),
      sb('recurring_task_deps?select=habit_id,depends_on_habit_id,dep_type,within_hours'),
      fetchCompetingPool(sb, today, endYmd),
      sb('scheduling_rules?key=eq.daily_task_cap_min&select=value'),
    ]);
    const capMin = Number(rules?.[0]?.value || 240);
    const competition = competitionForRange(today, endYmd, pool.tasks, pool.habits, capMin);
    const habitMap = new Map((Array.isArray(allHabits) ? allHabits : []).map((h) => [h.id, h]));
    const depsByHabit = new Map();
    for (const d of Array.isArray(deps) ? deps : []) {
      if (!depsByHabit.has(d.habit_id)) depsByHabit.set(d.habit_id, []);
      depsByHabit.get(d.habit_id).push(d);
    }
    const occurrences = [];
    const skipped = [];
    for (const h of Array.isArray(habits) ? habits : []) {
      let dates = [];
      try { dates = occurrencesInRange(h.rrule, today, endYmd); }
      catch (e) { skipped.push({ habit_id: h.id, title: h.title, reason: 'bad_rrule' }); continue; }
      if (!dates.length) {
        skipped.push({ habit_id: h.id, title: h.title, reason: 'no_occurrences' });
        continue;
      }
      const habitDeps = depsByHabit.get(h.id) || [];
      for (const idealDate of dates) {
        const blockedBy = buildBlockedBy(habitDeps, habitMap, idealDate);
        const blocked = blockedBy.some((b) => !b.satisfied);
        const comp = competition[idealDate] || { placed: [], displaced: [] };
        const place = blocked
          ? { placement: 'blocked', roll_forward: true, displacement_reason: 'dependency_unsatisfied' }
          : placementForOccurrence(comp, 'habit', h.id);
        occurrences.push({
          habit_id: h.id,
          title: h.title,
          priority: h.priority || 'p1',
          ideal_date: idealDate,
          ideal_time: fmtTime(h.ideal_time),
          duration_min: h.duration_min,
          window_days: h.window_days,
          cadence_text: h.cadence_text,
          projection_key: `habit-${h.id}-${idealDate}`,
          last_scheduled: h.last_scheduled || null,
          last_done: h.last_done || null,
          rolls_used: h.rolls_used ?? 0,
          blocked_by: blockedBy,
          blocked,
          ...place,
        });
      }
    }
    occurrences.sort((a, b) => a.ideal_date.localeCompare(b.ideal_date) || a.title.localeCompare(b.title));
    return json(res, 200, {
      configured: true,
      generated_at: new Date().toISOString(),
      today,
      timezone: 'Europe/London',
      horizon_days: horizon,
      horizon_end: endYmd,
      priority_order: PRIORITY_ORDER,
      placement_rule: 'higher_priority_first_then_roll_forward_never_skip',
      count: occurrences.length,
      occurrences,
      skipped,
      calendar_writes: 0,
    });
  } catch {
    return json(res, 200, {
      configured: true, today, horizon_days: horizon, error: 'fail-silent',
      occurrences: [], skipped: [], calendar_writes: 0,
    });
  }
};
