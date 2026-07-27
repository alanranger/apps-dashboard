/**
 * Wire joint habit placer → pending_diary_changes (proposals only; no Calendar writes).
 */
const { ruleMapFromRows, bankHolidaySet, addDays, isoToLondonDate } = require('./scheduling-rules-lib');
const {
  buildBusyIntervals, datedTasksToIntervals, findTaskBumps, findBlockedDayTaskBumps,
  findAwayIntervalTaskBumps, findAdminGapTaskBumps, findAfterHoursTaskBumps,
  findPastIncompleteTaskBumps, findSoftOverlapBumps,
  mergeTaskBumps, placeBumpedTasks,
  placeHabits, buildAmendments, provePlacement, awaySpansFromTravelBlocks,
  teachingDaySpansFromEvents, restDaySpansFromWorkshopEvents, restDaySpansFromDbRows,
  trySlotOnDay, dayBlockedForPlacement, dayBlockedForHabits,
} = require('./habit-placer-lib');
const { relatedIdForTask, relatedIdForHabit, upsertPushRow } = require('./gcal-push-lib');
const { occurrencesInRange } = require('./rrule-core');
const { computeMissedProposal } = require('./missed-habit-lib');

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
  const why = b.reason === 'on_blocked_day'
    ? 'Task on rest/away day'
    : b.reason === 'past_slot_incomplete'
      ? 'Slot passed without Complete/Skip — roll to next free slot'
      : b.reason === 'task_overlap'
        ? 'Task overlaps another task'
        : 'Habits outrank dated tasks (unpinned)';
  if (b.unplaced || !b.new_start) {
    return {
      change_type: 'task_bump',
      target_date: b.habit_day,
      urgency: 'high',
      status: 'pending',
      related_id: `task_bump:MC-${b.display_id}:${b.habit_day}`,
      summary: `UNPLACED bump MC-${b.display_id}: no legal slot (${why})`,
      proposed_action: `FLAG MC-${b.display_id} ("${bare}") — cannot place within 14d under cap/window/gaps. ${why}.`,
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
    related_id: `task_bump:MC-${b.display_id}:${b.habit_day || day}`,
    summary: `Bump MC-${b.display_id} → ${day} ${when}`,
    proposed_action: `MOVE MC-${b.display_id} ("${bare}") to ${day} ${when} (was ${isoToLondonDate(b.task_start)} ${londonHm(b.task_start)}–${londonHm(b.task_end)}). ${why}. Update tasks.scheduled_start/end.`,
    reason: `${why}; concrete slot chosen by placer`,
  };
}

async function applyTaskBumpToDb(sb, bump) {
  if (!bump?.new_start || bump.unplaced) return false;
  const rows = await sb(
    `tasks?display_id=eq.${Number(bump.display_id)}&select=id,display_id,title,calendar_event_id,scheduled_start,scheduled_end`,
  );
  const task = rows?.[0];
  if (!task) return false;
  if (task.scheduled_start === bump.new_start && task.scheduled_end === bump.new_end) return true;
  await sb(`tasks?id=eq.${task.id}`, {
    method: 'PATCH',
    prefer: 'return=minimal',
    body: {
      scheduled_start: bump.new_start,
      scheduled_end: bump.new_end,
      last_activity_at: new Date().toISOString(),
    },
  });
  await upsertPushRow(sb, {
    related_id: relatedIdForTask(task.id),
    entity_type: 'task',
    change_kind: 'move',
    summary: `Scheduler bump MC-${task.display_id} → ${bump.new_day || isoToLondonDate(bump.new_start)}`,
    proposed_action: [
      `MOVE MC-${task.display_id} ("${task.title}") to ${bump.new_start}–${bump.new_end}.`,
      task.calendar_event_id ? `event_id=${task.calendar_event_id}` : 'create if missing',
      `Reason: ${bump.reason || 'task_bump'}.`,
    ].join(' '),
    payload: {
      task_id: task.id,
      display_id: task.display_id,
      new_start: bump.new_start,
      new_end: bump.new_end,
      from_start: bump.task_start || null,
      reason: bump.reason || 'task_bump',
      calendar_event_id: task.calendar_event_id || null,
    },
  });
  return true;
}

/** Apply placer MOVE/CREATE/DELETE/KEEP(pin-sync) to recurring_log + gcal_push_queue. */
async function applyHabitAmendmentToDb(sb, a) {
  if (!a || !a.habit_id || !a.ideal_date) return false;
  const logRows = await sb(
    `recurring_log?recurring_task_id=eq.${a.habit_id}&ideal_date=eq.${a.ideal_date}`
    + '&select=id,calendar_event_id,scheduled_date,change&order=at.desc&limit=1',
  );
  const keepId = logRows?.[0]?.id || null;
  const evtId = a.calendar_event_id || logRows?.[0]?.calendar_event_id || null;
  const log = logRows?.[0] || null;

  // KEEP: Google may already match plan while recurring_log pin/scheduled_date is stale.
  if (a.action === 'KEEP') {
    if (!a.startIso || !a.endIso || !keepId) return false;
    const day = isoToLondonDate(a.startIso) || a.ideal_date;
    const pinChange = `diary_pin:${a.startIso}|${a.endIso}`;
    if (log?.scheduled_date === day && log?.change === pinChange && log?.calendar_event_id === evtId) {
      return false;
    }
    await sb(`recurring_log?id=eq.${keepId}`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: {
        change: pinChange,
        scheduled_date: day,
        roll_reason: 'habit_placer_keep_sync',
        calendar_event_id: evtId,
        ideal_date: a.ideal_date,
        projection_key: `placer:${a.habit_id}:${a.ideal_date}`,
      },
    });
    return true;
  }

  // Unplaced / dropped: never leave a dated scheduled_date (esp. on rest/away).
  // Queue Google delete BEFORE clearing calendar_event_id so the id is never lost.
  if (a.action === 'DELETE') {
    if (evtId) {
      await upsertPushRow(sb, {
        related_id: relatedIdForHabit(a.habit_id, a.ideal_date, evtId),
        entity_type: 'habit',
        change_kind: 'skip',
        summary: `Placer unplace: ${a.title} (${a.ideal_date})`,
        proposed_action: [
          `DELETE Primary event ${evtId} for habit "${a.title}".`,
          `ideal_date=${a.ideal_date}; scheduled_date=null (no legal slot / blocked day).`,
        ].join(' '),
        payload: {
          habit_id: a.habit_id,
          title: a.title,
          ideal_date: a.ideal_date,
          calendar_event_id: evtId,
          action: 'delete_event',
        },
      });
    }
    if (keepId) {
      await sb(`recurring_log?id=eq.${keepId}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: {
          change: `unplaced ${a.ideal_date}|habit_placer`,
          scheduled_date: null,
          roll_reason: 'habit_placer_unplace',
          calendar_event_id: null,
          ideal_date: a.ideal_date,
          projection_key: `placer:${a.habit_id}:${a.ideal_date}`,
        },
      });
    }
    return true;
  }

  if (a.action !== 'MOVE' && a.action !== 'CREATE') return false;
  if (!a.startIso || !a.endIso) return false;
  const pinChange = `diary_pin:${a.startIso}|${a.endIso}`;
  const day = isoToLondonDate(a.startIso) || a.ideal_date;
  const logBody = {
    change: pinChange,
    scheduled_date: day,
    roll_reason: 'habit_placer_enforce',
    calendar_event_id: evtId,
    ideal_date: a.ideal_date,
    projection_key: `placer:${a.habit_id}:${a.ideal_date}`,
  };
  if (keepId) {
    await sb(`recurring_log?id=eq.${keepId}`, {
      method: 'PATCH', prefer: 'return=minimal', body: logBody,
    });
  } else {
    await sb('recurring_log', {
      method: 'POST', prefer: 'return=minimal',
      body: { recurring_task_id: a.habit_id, actor: 'cursor', ...logBody },
    });
  }
  await upsertPushRow(sb, {
    related_id: relatedIdForHabit(a.habit_id, a.ideal_date, evtId),
    entity_type: 'habit',
    change_kind: 'move',
    summary: `Placer ${a.action}: ${a.title} → ${day}`,
    proposed_action: [
      `MOVE/CREATE habit "${a.title}" block to ${a.startIso} – ${a.endIso}.`,
      evtId ? `event_id=${evtId}` : 'Create Primary event',
      `ideal_date=${a.ideal_date}; scheduled_date=${day}.`,
    ].join(' '),
    payload: {
      habit_id: a.habit_id,
      title: a.title,
      ideal_date: a.ideal_date,
      new_start: a.startIso,
      new_end: a.endIso,
      calendar_event_id: evtId,
    },
  });
  return true;
}

/**
 * Belt-and-suspenders: any habit still dated on rest/away/teaching must MOVE to
 * placement day or be unplaced (scheduled_date null). Blocked day is never valid.
 */
async function clearHabitsDatedOnBlockedDays(sb, blockedSpans, fromYmd, toYmd, placements) {
  const placeByKey = new Map(
    (placements || []).map((p) => [`${p.habit_id}|${p.ideal_date}`, p]),
  );
  const logs = await sb(
    `recurring_log?scheduled_date=gte.${fromYmd}&scheduled_date=lte.${toYmd}`
    + '&select=id,recurring_task_id,ideal_date,scheduled_date,calendar_event_id,at'
    + '&order=at.desc&limit=5000',
  );
  const seen = new Set();
  const cleared = [];
  for (const row of logs || []) {
    if (!row?.recurring_task_id || !row.scheduled_date) continue;
    const ideal = row.ideal_date || String(row.scheduled_date).slice(0, 10);
    const k = `${row.recurring_task_id}|${ideal}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const day = String(row.scheduled_date).slice(0, 10);
    if (!dayBlockedForHabits(day, blockedSpans)) continue;
    const p = placeByKey.get(k);
    try {
      if (p?.startIso && p?.endIso && p.day && !dayBlockedForHabits(p.day, blockedSpans)) {
        const ok = await applyHabitAmendmentToDb(sb, {
          action: 'MOVE',
          habit_id: row.recurring_task_id,
          title: p.title || 'habit',
          ideal_date: ideal,
          startIso: p.startIso,
          endIso: p.endIso,
          calendar_event_id: row.calendar_event_id || null,
          from_startIso: null,
        });
        if (ok) cleared.push({ title: p.title, from: day, to: p.day, action: 'MOVE' });
        continue;
      }
      const ok = await applyHabitAmendmentToDb(sb, {
        action: 'DELETE',
        habit_id: row.recurring_task_id,
        title: p?.title || 'habit',
        ideal_date: ideal,
        startIso: null,
        endIso: null,
        calendar_event_id: row.calendar_event_id || null,
      });
      if (ok) cleared.push({ title: p?.title || ideal, from: day, to: null, action: 'UNPLACE' });
    } catch (e) {
      cleared.push({
        title: p?.title || ideal, from: day, to: null, action: 'ERROR', error: e.message,
      });
    }
  }
  return cleared;
}

/** Past habit ideals with no Complete/Skip → concrete next-slot pin + GCal queue. */
async function applyIncompleteHabitRolls(ctx) {
  const {
    sb, habits, ruleMap, holidays, hardBusy, placements, dayUsed, fromYmd, awaySpans,
    existingPending, inserted, writePending = true,
  } = ctx;
  const today = fromYmd;
  const lookback = addDays(today, -21);
  let rolled = 0;
  const busyWork = (hardBusy || []).slice();
  for (const p of placements || []) {
    busyWork.push({
      startMs: Date.parse(p.startIso),
      endMs: Date.parse(p.endIso),
      summary: p.title,
    });
  }
  const used = { ...(dayUsed || {}) };

  for (const habit of habits || []) {
    const ideals = occurrencesInRange(habit.rrule, lookback, addDays(today, -1), 40);
    for (const ideal of ideals) {
      if (habit.last_done && String(habit.last_done) >= String(ideal)) continue;
      const skipRows = await sb(
        `recurring_log?recurring_task_id=eq.${habit.id}&ideal_date=eq.${ideal}`
        + `&change=like.${encodeURIComponent('skipped%')}&limit=1`,
      );
      if (skipRows?.[0]) continue;
      const doneRows = await sb(
        `recurring_log?recurring_task_id=eq.${habit.id}&ideal_date=eq.${ideal}`
        + `&change=like.${encodeURIComponent('completed%')}&limit=1`,
      );
      if (doneRows?.[0]) continue;

      const prop = computeMissedProposal({
        habit, lastDue: ideal, today, ruleMap, holidays, maxRolls: Number(ruleMap.max_habit_rolls || 3),
      });
      if (/UNPLACEABLE/i.test(prop.proposed || '')) {
        if (writePending && existingPending) {
          const relatedId = `habit:${habit.id}:${ideal}`;
          if (!(await existingPending('missed_habit', relatedId))) {
            const out = await sb('pending_diary_changes', {
              method: 'POST',
              body: {
                change_type: 'missed_habit',
                target_date: ideal,
                summary: `Missed habit: ${habit.title}`,
                proposed_action: prop.proposed,
                reason: prop.reason,
                urgency: prop.urgency || 'high',
                status: 'pending',
                related_id: relatedId,
              },
            });
            const id = Array.isArray(out) ? out[0]?.id : out?.id;
            if (id && inserted) inserted.push(id);
          }
        }
        continue;
      }

      let slot = null;
      for (let i = 0; i < 14; i += 1) {
        const day = addDays(today, i);
        if (dayBlockedForHabits(day, awaySpans || [])) continue;
        const trial = trySlotOnDay(
          day, Number(habit.duration_min) || 60, habit.ideal_time || '09:00',
          habit.title, busyWork, placements || [], used, ruleMap,
        );
        if (trial) { slot = trial; break; }
      }
      if (!slot) continue;

      const pinChange = `diary_pin:${slot.startIso}|${slot.endIso}`;
      const logRows = await sb(
        `recurring_log?recurring_task_id=eq.${habit.id}&ideal_date=eq.${ideal}`
        + '&select=id,calendar_event_id&order=at.desc&limit=1',
      );
      const keepId = logRows?.[0]?.id || null;
      const evtId = logRows?.[0]?.calendar_event_id || null;
      const logBody = {
        change: pinChange,
        scheduled_date: slot.day,
        roll_reason: 'incomplete_auto_roll',
        calendar_event_id: evtId,
        ideal_date: ideal,
        projection_key: `auto-roll:${habit.id}:${ideal}`,
      };
      if (keepId) {
        await sb(`recurring_log?id=eq.${keepId}`, {
          method: 'PATCH', prefer: 'return=minimal', body: logBody,
        });
      } else {
        await sb('recurring_log', {
          method: 'POST', prefer: 'return=minimal',
          body: { recurring_task_id: habit.id, actor: 'cursor-auto-roll', ...logBody },
        });
      }
      await sb(`recurring_tasks?id=eq.${habit.id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: {
          last_scheduled: slot.day,
          scheduled_note: `${slot.day} auto-roll (incomplete ${ideal})`,
          updated_at: new Date().toISOString(),
        },
      });
      await upsertPushRow(sb, {
        related_id: relatedIdForHabit(habit.id, ideal, evtId),
        entity_type: 'habit',
        change_kind: 'move',
        summary: `Auto-roll habit ${habit.title} → ${slot.day}`,
        proposed_action: [
          `MOVE/CREATE habit "${habit.title}" block to ${slot.startIso} – ${slot.endIso}.`,
          evtId ? `event_id=${evtId}` : 'Create Primary event then PATCH recurring_log.calendar_event_id',
          `ideal_date=${ideal}; scheduled_date=${slot.day}. Incomplete slot — not Complete/Skip.`,
        ].join(' '),
        payload: {
          habit_id: habit.id,
          title: habit.title,
          ideal_date: ideal,
          new_start: slot.startIso,
          new_end: slot.endIso,
          calendar_event_id: evtId,
        },
      });
      // Resolve any pending missed_habit for this ideal
      await sb(
        `pending_diary_changes?change_type=eq.missed_habit&related_id=eq.${encodeURIComponent(`habit:${habit.id}:${ideal}`)}&status=eq.pending`,
        {
          method: 'PATCH', prefer: 'return=minimal',
          body: {
            status: 'applied',
            resolved_at: new Date().toISOString(),
            resolved_by: 'incomplete_auto_roll',
            proposed_action: `AUTO-APPLIED → ${slot.day} ${londonHm(slot.startIso)}–${londonHm(slot.endIso)}`,
          },
        },
      );
      used[slot.day] = (used[slot.day] || 0) + slot.durationMin;
      busyWork.push({
        startMs: Date.parse(slot.startIso),
        endMs: Date.parse(slot.endIso),
        summary: habit.title,
      });
      rolled += 1;
    }
  }
  return { rolled };
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

  const [habits, deps, logs, taskRows, travelBlocks, restDb] = await Promise.all([
    sb('recurring_tasks?select=id,title,priority,duration_min,ideal_time,window_days,time_critical,rrule,last_done,rolls_used&active=eq.true'),
    sb('recurring_task_deps?select=habit_id,depends_on_habit_id,dep_type,within_hours'),
    sb('recurring_log?calendar_event_id=not.is.null&select=recurring_task_id,ideal_date,scheduled_date,calendar_event_id&order=at.desc&limit=5000'),
    sb(
      'tasks?select=display_id,title,state,slot_pinned,scheduled_start,scheduled_end,calendar_event_id,'
      + 'depends_on:depends_on_task_id(display_id)'
      + '&scheduled_start=not.is.null'
      + `&scheduled_start=gte.${addDays(fromYmd, -21)}T00:00:00Z`
      + `&scheduled_start=lte.${toYmd}T23:59:59Z`
      + '&state=not.in.(done,verified,wont_do,superseded)',
    ),
    sb(
      'travel_blocks?select=block_type,starts_at,ends_at,venue_name,workshop_title,workshop_start,workshop_row_key'
      + '&block_type=in.(travel_out,travel_back)'
      + `&starts_at=gte.${fromYmd}T00:00:00Z`
      + `&starts_at=lte.${toYmd}T23:59:59Z`,
    ),
    sb(`rest_day_blocks?status=eq.active&rest_date=gte.${fromYmd}&rest_date=lte.${toYmd}&select=rest_date,workshop_title`),
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
  const restSpans = restDaySpansFromWorkshopEvents(gcalEvents || [], ruleMap)
    .concat(restDaySpansFromDbRows(restDb || []));
  const blockedSpans = awaySpans.concat(teachingSpans).concat(restSpans);
  // Existing habit blocks must occupy the busy map (buildBusyIntervals skips MC titles).
  const existingHabitBusy = (existingLog || []).map((e) => ({
    startMs: Date.parse(e.startIso),
    endMs: Date.parse(e.endIso),
    summary: e.title,
    habit_id: e.habit_id,
    ideal_date: e.ideal_date,
  })).filter((b) => Number.isFinite(b.startMs) && Number.isFinite(b.endMs));
  const hardBusy = clientBusy.concat(pinnedBusy).concat(blockedSpans).concat(existingHabitBusy)
    .sort((a, b) => a.startMs - b.startMs);

  const { placements, unplaced } = placeHabits(
    habits || [], deps || [], hardBusy.slice(), ruleMap, holidays, fromYmd, toYmd,
    { softTaskIntervals: softTasks, existingHabitIntervals: existingHabitBusy },
  );
  const existing = enrichExistingFromGcalTitles(
    existingLog, habits || [], gcalEvents || [], placements,
  );
  const bumpsRaw = mergeTaskBumps(
    findTaskBumps(placements, softTasks),
    findBlockedDayTaskBumps(softTasks, blockedSpans),
    findAwayIntervalTaskBumps(softTasks, awaySpans),
    findAdminGapTaskBumps(softTasks, ruleMap),
    findAfterHoursTaskBumps(softTasks, ruleMap),
    findPastIncompleteTaskBumps(softTasks, Date.now()),
    findSoftOverlapBumps(softTasks),
  );
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
  let taskDbApplied = 0;
  let habitDbApplied = 0;
  let habitRolls = { rolled: 0 };
  const proofOk = !!proof?.ok;
  if (writePending) {
    for (const a of amendments) {
      // Always persist plan times to recurring_log (KEEP can hide stale scheduled_date vs GCal).
      const writeAction = (a.action === 'KEEP' && proofOk)
        ? { ...a, action: 'MOVE', from_startIso: a.startIso, from_endIso: a.endIso }
        : a;
      const mayWrite = writeAction.action === 'DELETE'
        || ((writeAction.action === 'MOVE' || writeAction.action === 'CREATE') && proofOk);
      if (mayWrite) {
        try {
          if (await applyHabitAmendmentToDb(sb, writeAction)) habitDbApplied += 1;
        } catch (_) { /* pending row still written below */ }
      }
      const row = amendmentToPending(a);
      if (!row) continue;
      if (existingPending && await existingPending(row.change_type, row.related_id)) continue;
      const applied = mayWrite && a.action !== 'KEEP';
      const out = await sb('pending_diary_changes', {
        method: 'POST',
        body: {
          ...row,
          status: applied ? 'applied' : (a.action === 'KEEP' ? 'applied' : row.status),
          resolved_at: (applied || a.action === 'KEEP') ? new Date().toISOString() : null,
          resolved_by: (applied || a.action === 'KEEP') ? 'habit_placer_enforce' : null,
        },
      });
      const id = Array.isArray(out) ? out[0]?.id : out?.id;
      if (id && inserted) inserted.push(id);
      if (id) pendingWrote += 1;
    }
    for (const b of allBumps) {
      // Diary is DB-master: apply concrete bumps immediately + queue GCal.
      if (!b.unplaced && b.new_start) {
        try {
          if (await applyTaskBumpToDb(sb, b)) taskDbApplied += 1;
        } catch (e) {
          /* keep pending row below so Alan still sees the intent */
        }
      }
      const row = bumpToPending(b);
      if (existingPending && await existingPending(row.change_type, row.related_id)) continue;
      const out = await sb('pending_diary_changes', {
        method: 'POST',
        body: {
          ...row,
          status: (!b.unplaced && b.new_start) ? 'applied' : row.status,
          resolved_at: (!b.unplaced && b.new_start) ? new Date().toISOString() : null,
          resolved_by: (!b.unplaced && b.new_start) ? 'habit_placer_auto' : null,
        },
      });
      const id = Array.isArray(out) ? out[0]?.id : out?.id;
      if (id && inserted) inserted.push(id);
      if (id) pendingWrote += 1;
    }
    try {
      habitRolls = await applyIncompleteHabitRolls({
        sb,
        habits: habits || [],
        ruleMap,
        holidays,
        hardBusy,
        placements,
        fromYmd,
        awaySpans: blockedSpans,
        existingPending,
        inserted,
        writePending,
      });
    } catch (e) {
      habitRolls = { rolled: 0, error: e.message };
    }
  }

  let blockedCleared = [];
  if (writePending) {
    try {
      blockedCleared = await clearHabitsDatedOnBlockedDays(
        sb, blockedSpans, fromYmd, toYmd, placements,
      );
      habitDbApplied += blockedCleared.length;
    } catch (e) {
      blockedCleared = [{ error: e.message }];
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
    task_db_applied: taskDbApplied,
    habit_db_applied: habitDbApplied,
    blocked_day_cleared: blockedCleared,
    habit_rolls: habitRolls,
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
  applyTaskBumpToDb,
  applyHabitAmendmentToDb,
  clearHabitsDatedOnBlockedDays,
  applyIncompleteHabitRolls,
  runHabitPlacerPropose,
  ruleMapFromRows,
  bankHolidaySet,
  addDays,
};
