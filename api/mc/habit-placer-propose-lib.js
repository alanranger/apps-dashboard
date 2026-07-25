/**
 * Wire joint habit placer → pending_diary_changes (proposals only; no Calendar writes).
 */
const { ruleMapFromRows, bankHolidaySet, addDays, isoToLondonDate } = require('./scheduling-rules-lib');
const {
  buildBusyIntervals, placeHabits, buildAmendments, provePlacement, londonYmdHmToUtcMs,
} = require('./habit-placer-lib');

function hmLabel(mins) {
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

function parseHm(hm) {
  const [h, m] = String(hm || '10:00').slice(0, 5).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

function londonHm(iso) {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(iso));
  } catch (e) {
    return String(iso).slice(11, 16);
  }
}

function relatedId(habitId, idealDate) {
  return `habit_place:${habitId}:${idealDate}`;
}

/** Existing keyed habit blocks from recurring_log (+ GCal times when available). */
function loadExistingFromLog(logs, habits, gcalEvents) {
  const habitById = new Map((habits || []).map((h) => [h.id, h]));
  const byEvent = new Map();
  for (const e of gcalEvents || []) {
    if (e?.id) byEvent.set(e.id, e);
  }
  const best = new Map();
  for (const row of logs || []) {
    if (!row.calendar_event_id || !row.ideal_date || !row.recurring_task_id) continue;
    const k = `${row.recurring_task_id}|${row.ideal_date}`;
    if (best.has(k)) continue;
    const habit = habitById.get(row.recurring_task_id);
    if (!habit) continue;
    const ev = byEvent.get(row.calendar_event_id);
    let startIso;
    let endIso;
    if (ev?.start?.dateTime) {
      startIso = new Date(ev.start.dateTime).toISOString();
      endIso = new Date(ev.end?.dateTime || ev.start.dateTime).toISOString();
    } else {
      const day = row.scheduled_date || row.ideal_date;
      const startMin = parseHm(habit.ideal_time || '10:00');
      const dur = Number(habit.duration_min) || 60;
      startIso = new Date(londonYmdHmToUtcMs(day, hmLabel(startMin))).toISOString();
      endIso = new Date(londonYmdHmToUtcMs(day, hmLabel(startMin + dur))).toISOString();
    }
    best.set(k, {
      habit_id: row.recurring_task_id,
      title: habit.title,
      ideal_date: row.ideal_date,
      startIso,
      endIso,
      calendar_event_id: row.calendar_event_id,
    });
  }
  return [...best.values()];
}

function amendmentToPending(a) {
  if (!a || a.action === 'KEEP') return null;
  const day = isoToLondonDate(a.startIso) || a.ideal_date;
  const when = `${londonHm(a.startIso)}–${londonHm(a.endIso)}`;
  const base = {
    change_type: 'habit_placement',
    target_date: day,
    urgency: a.action === 'DELETE' ? 'medium' : 'low',
    status: 'pending',
    related_id: relatedId(a.habit_id, a.ideal_date),
  };
  if (a.action === 'CREATE') {
    return {
      ...base,
      summary: `Place habit: ${a.title} — ${day} ${when}`,
      proposed_action: `CREATE Primary block "${a.title}" ${day} ${when} (ideal ${a.ideal_date}). Tie recurring_log.calendar_event_id.`,
      reason: 'Joint habit placer — no keyed calendar block for this occurrence',
    };
  }
  if (a.action === 'MOVE') {
    return {
      ...base,
      summary: `Move habit: ${a.title} → ${day} ${when}`,
      proposed_action: `MOVE event ${a.calendar_event_id} to ${day} ${when} (was ${londonHm(a.from_startIso)}–${londonHm(a.from_endIso)}).`,
      reason: 'Joint habit placer — existing block time/day differs from plan',
    };
  }
  if (a.action === 'DELETE') {
    return {
      ...base,
      summary: `Remove habit block: ${a.title} (${a.ideal_date})`,
      proposed_action: `DELETE Primary event ${a.calendar_event_id} (occurrence no longer in plan).`,
      reason: 'Joint habit placer — occurrence dropped or superseded',
    };
  }
  return null;
}

/**
 * Run placer + amendments; optionally insert pending rows (idempotent on related_id).
 * @returns summary for notes / spike JSON
 */
async function runHabitPlacerPropose(ctx) {
  const {
    sb, ruleMap, holidays, fromYmd, toYmd, gcalEvents,
    existingPending, inserted, writePending = true,
  } = ctx;

  const [habits, deps, logs] = await Promise.all([
    sb('recurring_tasks?select=id,title,priority,duration_min,ideal_time,window_days,time_critical,rrule&active=eq.true'),
    sb('recurring_task_deps?select=habit_id,depends_on_habit_id,dep_type,within_hours'),
    sb('recurring_log?calendar_event_id=not.is.null&select=recurring_task_id,ideal_date,scheduled_date,calendar_event_id&order=at.desc&limit=5000'),
  ]);

  const existing = loadExistingFromLog(logs || [], habits || [], gcalEvents || []);
  const clientBusy = buildBusyIntervals(gcalEvents || [], ruleMap);
  const { placements, unplaced } = placeHabits(
    habits || [], deps || [], clientBusy.slice(), ruleMap, holidays, fromYmd, toYmd,
  );
  const proof = provePlacement(placements, clientBusy, deps || [], ruleMap);
  const amendments = buildAmendments(placements, existing);
  const counts = amendments.reduce((acc, a) => {
    acc[a.action] = (acc[a.action] || 0) + 1;
    return acc;
  }, {});

  let pendingWrote = 0;
  if (writePending && proof.ok) {
    for (const a of amendments) {
      const row = amendmentToPending(a);
      if (!row) continue;
      if (existingPending && await existingPending(row.change_type, row.related_id)) continue;
      const out = await sb('pending_diary_changes', { method: 'POST', body: row });
      const id = Array.isArray(out) ? out[0]?.id : out?.id;
      if (id && inserted) inserted.push(id);
      if (id) pendingWrote += 1;
    }
  }

  return {
    placements,
    unplaced,
    amendments,
    amendment_counts: counts,
    existing_matched: existing.length,
    proof,
    pending_wrote: pendingWrote,
    calendar_writes: 0,
  };
}

module.exports = {
  relatedId,
  loadExistingFromLog,
  amendmentToPending,
  runHabitPlacerPropose,
  ruleMapFromRows,
  bankHolidaySet,
  addDays,
};
