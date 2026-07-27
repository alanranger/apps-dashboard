/**
 * Wire joint habit placer → pending_diary_changes (proposals only; no Calendar writes).
 */
const { ruleMapFromRows, bankHolidaySet, addDays, isoToLondonDate } = require('./scheduling-rules-lib');
const {
  buildBusyIntervals, datedTasksToIntervals, findTaskBumps, placeBumpedTasks,
  placeHabits, buildAmendments, provePlacement, awaySpansFromTravelBlocks,
  teachingDaySpansFromEvents, restDaySpansFromWorkshopEvents,
} = require('./habit-placer-lib');

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

/** Existing keyed habit blocks — calendar event times only (live diary = truth). */
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
    // Mid-apply / regen: skip log rows whose event is missing from live GCal.
    if (!ev?.start?.dateTime) continue;
    const startIso = new Date(ev.start.dateTime).toISOString();
    const endIso = new Date(ev.end?.dateTime || ev.start.dateTime).toISOString();
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

/** Match Primary habit events missing from recurring_log (partial-apply orphans). */
function enrichExistingFromGcalTitles(existing, habits, gcalEvents, placements) {
  const byEvent = new Set((existing || []).map((e) => e.calendar_event_id).filter(Boolean));
  const byKey = new Map((existing || []).map((e) => [`${e.habit_id}|${e.ideal_date}`, e]));
  const habitsList = habits || [];
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

  for (const e of gcalEvents || []) {
    const cal = e._calendarId || e.calendarId || 'primary';
    if (cal !== 'primary') continue;
    if (!e.id || !e.start?.dateTime || byEvent.has(e.id)) continue;
    const summary = norm(e.summary);
    if (!summary || /^mc\s*[⚽🚗⏳⏰]/.test(summary)) continue;
    const habit = habitsList.find((h) => {
      const t = norm(h.title);
      return t && (summary === t || summary.includes(t));
    });
    if (!habit) continue;
    const day = isoToLondonDate(e.start.dateTime);
    const hit = (placements || []).find((p) => p.habit_id === habit.id && p.day === day);
    const ideal = hit?.ideal_date || day;
    const k = `${habit.id}|${ideal}`;
    if (byKey.has(k)) continue;
    byKey.set(k, {
      habit_id: habit.id,
      title: habit.title,
      ideal_date: ideal,
      startIso: new Date(e.start.dateTime).toISOString(),
      endIso: new Date(e.end?.dateTime || e.start.dateTime).toISOString(),
      calendar_event_id: e.id,
    });
    byEvent.add(e.id);
  }
  return [...byKey.values()];
}

function amendmentToPending(a) {
  if (!a || a.action === 'KEEP') return null;
  const day = isoToLondonDate(a.startIso) || a.ideal_date;
  const when = `${londonHm(a.startIso)}–${londonHm(a.endIso)}`;
  const tie = `recurring_task_id=${a.habit_id}; ideal_date=${a.ideal_date}`;
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
      proposed_action: `CREATE Primary block "${a.title}" ${day} ${when}. ${tie}. Tie recurring_log.calendar_event_id after create.`,
      reason: 'Joint habit placer — no keyed calendar block for this occurrence',
    };
  }
  if (a.action === 'MOVE') {
    const fromDay = isoToLondonDate(a.from_startIso) || a.ideal_date;
    const fromWhen = `${londonHm(a.from_startIso)}–${londonHm(a.from_endIso)}`;
    return {
      ...base,
      summary: `Move habit: ${a.title} → ${day} ${when}`,
      proposed_action: `MOVE event ${a.calendar_event_id} to ${day} ${when} (was ${fromDay} ${fromWhen}). ${tie}.`,
      reason: 'Joint habit placer — existing block time/day differs from plan',
    };
  }
  if (a.action === 'DELETE') {
    return {
      ...base,
      summary: `Remove habit block: ${a.title} (${a.ideal_date})`,
      proposed_action: `DELETE Primary event ${a.calendar_event_id} (${day} ${when}). ${tie}.`,
      reason: 'Joint habit placer — occurrence dropped or superseded',
    };
  }
  return null;
}

function bumpToPending(b) {
  const bare = String(b.title || '').replace(/^MC-\d+\s*/, '');
  if (b.unplaced || !b.new_start) {
    return {
      change_type: 'task_bump',
      target_date: b.habit_day,
      urgency: 'high',
      status: 'pending',
      related_id: `task_bump:MC-${b.display_id}:${b.habit_day}`,
      summary: `UNPLACED bump MC-${b.display_id}: no legal slot (yields to "${b.habit_title}")`,
      proposed_action: `FLAG MC-${b.display_id} ("${bare}") — cannot place within 14d under cap/window/gaps. Habit "${b.habit_title}" owns ${b.habit_day} ${londonHm(b.habit_start)}–${londonHm(b.habit_end)}. Alan rules.`,
      reason: 'Task bump UNPLACED — Cursor could not find a concrete slot',
    };
  }
  const day = b.new_day || isoToLondonDate(b.new_start);
  const when = `${londonHm(b.new_start)}–${londonHm(b.new_end)}`;
  return {
    change_type: 'task_bump',
    target_date: day,
    urgency: 'medium',
    status: 'pending',
    related_id: `task_bump:MC-${b.display_id}:${b.habit_day}`,
    summary: `Bump MC-${b.display_id} → ${day} ${when}`,
    proposed_action: `MOVE MC-${b.display_id} ("${bare}") to ${day} ${when} (was ${isoToLondonDate(b.task_start)} ${londonHm(b.task_start)}–${londonHm(b.task_end)}). Yields to habit "${b.habit_title}" ${b.habit_day} ${londonHm(b.habit_start)}–${londonHm(b.habit_end)}. Update tasks.scheduled_start/end.`,
    reason: 'Habits outrank dated tasks (unpinned); concrete slot chosen by placer',
  };
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

  const [habits, deps, logs, taskRows, travelBlocks] = await Promise.all([
    sb('recurring_tasks?select=id,title,priority,duration_min,ideal_time,window_days,time_critical,rrule&active=eq.true'),
    sb('recurring_task_deps?select=habit_id,depends_on_habit_id,dep_type,within_hours'),
    sb('recurring_log?calendar_event_id=not.is.null&select=recurring_task_id,ideal_date,scheduled_date,calendar_event_id&order=at.desc&limit=5000'),
    sb(
      'tasks?select=display_id,title,state,slot_pinned,scheduled_start,scheduled_end,calendar_event_id,'
      + 'depends_on:depends_on_task_id(display_id)'
      + '&scheduled_start=not.is.null'
      + `&scheduled_start=gte.${fromYmd}T00:00:00Z`
      + `&scheduled_start=lte.${toYmd}T23:59:59Z`
      + '&state=not.in.(done,verified,wont_do,superseded)',
    ),
    sb(
      'travel_blocks?select=block_type,starts_at,ends_at,venue_name,workshop_title,workshop_start,workshop_row_key'
      + '&block_type=in.(travel_out,travel_back)'
      + `&starts_at=gte.${fromYmd}T00:00:00Z`
      + `&starts_at=lte.${toYmd}T23:59:59Z`,
    ),
  ]);

  const taskRowsNorm = (taskRows || []).map((t) => ({
    ...t,
    depends_on_display_id: t.depends_on?.display_id ?? t.depends_on_display_id ?? null,
  }));
  const existingLog = loadExistingFromLog(logs || [], habits || [], gcalEvents || []);
  const clientBusy = buildBusyIntervals(gcalEvents || [], ruleMap);
  const pinnedBusy = datedTasksToIntervals(taskRowsNorm, { pinnedOnly: true });
  const softTasks = datedTasksToIntervals(taskRowsNorm, { pinnedOnly: false });
  const awaySpans = awaySpansFromTravelBlocks(travelBlocks || []);
  const teachingSpans = teachingDaySpansFromEvents(gcalEvents || [], ruleMap);
  const restSpans = restDaySpansFromWorkshopEvents(gcalEvents || [], ruleMap);
  const hardBusy = clientBusy.concat(pinnedBusy).concat(awaySpans).concat(teachingSpans)
    .concat(restSpans)
    .sort((a, b) => a.startMs - b.startMs);

  const { placements, unplaced } = placeHabits(
    habits || [], deps || [], hardBusy.slice(), ruleMap, holidays, fromYmd, toYmd,
  );
  const existing = enrichExistingFromGcalTitles(
    existingLog, habits || [], gcalEvents || [], placements,
  );
  const bumpsRaw = findTaskBumps(placements, softTasks);
  const {
    scheduled: bumps, unplaced: bumpUnplaced, shared_calendar_flags: sharedFlags,
  } = placeBumpedTasks(
    bumpsRaw, softTasks, hardBusy, placements, ruleMap, holidays, fromYmd,
  );
  const allBumps = bumps.concat(bumpUnplaced);
  const proof = provePlacement(placements, hardBusy, deps || [], ruleMap, {
    softTaskIntervals: softTasks,
    bumps: allBumps,
  });
  const amendments = buildAmendments(placements, existing, fromYmd);
  const counts = amendments.reduce((acc, a) => {
    acc[a.action] = (acc[a.action] || 0) + 1;
    return acc;
  }, {});
  const skippedPast = buildAmendments(placements, existing).length - amendments.length;

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
    for (const b of allBumps) {
      const row = bumpToPending(b);
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
    dated_tasks_seen: taskRowsNorm.length,
    pinned_busy: pinnedBusy.length,
    soft_tasks: softTasks.length,
    away_spans: awaySpans.map((s) => ({
      startDay: s.startDay, endDay: s.endDay, restDay: s.restDay, summary: s.summary,
    })),
    away_span_count: awaySpans.length,
    rest_days: restSpans.map((s) => ({
      restDay: s.restDay, firstDay: s.firstDay, lastDay: s.lastDay,
      workshop_title: s.workshop_title, summary: s.summary,
    })),
    rest_day_count: restSpans.length,
    teaching_days: teachingSpans.map((s) => s.startDay),
    teaching_day_count: teachingSpans.length,
    task_bumps: allBumps,
    task_bump_count: allBumps.length,
    task_bump_scheduled: bumps.length,
    task_bump_unplaced: bumpUnplaced.length,
    shared_calendar_flags: sharedFlags || [],
    skipped_past: skippedPast,
    proof,
    pending_wrote: pendingWrote,
    calendar_writes: 0,
  };
}

module.exports = {
  relatedId,
  loadExistingFromLog,
  enrichExistingFromGcalTitles,
  amendmentToPending,
  bumpToPending,
  runHabitPlacerPropose,
  ruleMapFromRows,
  bankHolidaySet,
  addDays,
};
