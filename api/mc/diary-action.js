/**
 * POST /api/mc/diary-action — move/complete/skip/pin/unlock; DB + push queue only.
 * Never writes Google Calendar.
 */
const {
  envReady, json, cors, readBody, requireAuth, actorFromSession, sb, logChange,
} = require('./_lib');
const {
  warnDrop, ruleMapFromRows, awaySpansFromTravelBlocks, tasksToBlocks, habitLogsToBlocks,
} = require('./diary-lib');
const {
  relatedIdForTask, relatedIdForHabit, upsertPushRow, supersedeSiblingHabitRows,
} = require('./gcal-push-lib');
const { isoToLondonDate, isoToLondonMinutes } = require('./scheduling-rules-lib');

async function loadPeers(fromIso, toIso) {
  const [tasks, habits, logs] = await Promise.all([
    sb(`tasks?select=id,display_id,title,scheduled_start,scheduled_end,slot_pinned,calendar_event_id&scheduled_start=gte.${fromIso}&scheduled_start=lt.${toIso}`),
    sb('recurring_tasks?select=id,title,duration_min,ideal_time,last_done&active=eq.true'),
    sb('recurring_log?select=recurring_task_id,ideal_date,scheduled_date,calendar_event_id,change,at&scheduled_date=gte.'
      + `${fromIso.slice(0, 10)}&scheduled_date=lte.${toIso.slice(0, 10)}`),
  ]);
  const habitMap = new Map((habits || []).map((h) => [h.id, h]));
  return [...tasksToBlocks(tasks), ...habitLogsToBlocks(logs, habitMap)];
}

async function moveTask(body, actor) {
  const rows = await sb(`tasks?id=eq.${body.task_id}&select=id,display_id,title,due_date,slot_pinned,scheduled_start,scheduled_end,calendar_event_id`);
  const task = rows?.[0];
  if (!task) {
    const err = new Error('task not found');
    err.status = 404;
    throw err;
  }
  if (task.slot_pinned && body.action === 'move') {
    const err = new Error('Pinned — unlock before dragging');
    err.status = 409;
    err.blocked = true;
    throw err;
  }
  const patch = {
    scheduled_start: body.new_start,
    scheduled_end: body.new_end,
    slot_pinned: true,
    slot_pinned_at: new Date().toISOString(),
    slot_pinned_from: task.scheduled_start || null,
    last_activity_at: new Date().toISOString(),
  };
  await sb(`tasks?id=eq.${task.id}`, { method: 'PATCH', prefer: 'return=minimal', body: patch });
  await logChange(task.id, actor, `diary move: ${task.scheduled_start || '?'} → ${body.new_start}`);
  const day = isoToLondonDate(body.new_start);
  const action = [
    `MOVE GCal event for MC-${task.display_id} (${task.title})`,
    `to ${body.new_start} – ${body.new_end} (London).`,
    task.calendar_event_id ? `event_id=${task.calendar_event_id}` : 'CREATE if missing, then set tasks.calendar_event_id',
    'Do NOT change due_date. slot_pinned=true already set in DB.',
  ].join(' ');
  await upsertPushRow(sb, {
    related_id: relatedIdForTask(task.id),
    entity_type: 'task',
    change_kind: 'move',
    summary: `Move MC-${task.display_id} → ${day}`,
    proposed_action: action,
    payload: {
      task_id: task.id,
      display_id: task.display_id,
      title: task.title,
      new_start: body.new_start,
      new_end: body.new_end,
      calendar_event_id: task.calendar_event_id || null,
      due_date: task.due_date,
    },
  });
  await sb('pending_diary_changes', {
    method: 'POST', prefer: 'return=minimal',
    body: {
      change_type: 'diary_manual_move',
      related_id: relatedIdForTask(task.id),
      target_date: day,
      summary: `Diary grid: moved MC-${task.display_id} (${task.title}) → ${day}`,
      proposed_action: action,
      reason: 'alan_diary_grid',
      urgency: 'normal',
      status: 'pending',
    },
  });
  return { task_id: task.id, display_id: task.display_id, due_date: task.due_date, slot_pinned: true, queued: true };
}

async function moveHabit(body, actor) {
  const habitId = body.habit_id;
  const ideal = body.ideal_date || body.new_start?.slice(0, 10);
  const rows = await sb(`recurring_tasks?id=eq.${habitId}&select=id,title,duration_min,ideal_time`);
  const habit = rows?.[0];
  if (!habit) {
    const err = new Error('habit not found');
    err.status = 404;
    throw err;
  }
  const day = isoToLondonDate(body.new_start);
  const pinChange = `diary_pin:${body.new_start}|${body.new_end}`;
  const note = `${day} ${String(body.new_start).slice(11, 16)} (diary pin)`;
  const projectionKey = body.projection_key || `diary:${habit.id}:${ideal}`;
  await sb(`recurring_tasks?id=eq.${habit.id}`, {
    method: 'PATCH', prefer: 'return=minimal',
    body: {
      last_scheduled: day,
      scheduled_note: note,
      updated_at: new Date().toISOString(),
    },
  });
  // Idempotent: one row per habit+ideal (also match live event id / projection_key).
  let existing = await sb(
    `recurring_log?recurring_task_id=eq.${habit.id}&ideal_date=eq.${ideal}`
    + '&select=id&order=at.desc&limit=5',
  );
  if (!existing?.[0] && body.calendar_event_id) {
    existing = await sb(
      `recurring_log?recurring_task_id=eq.${habit.id}`
      + `&calendar_event_id=eq.${encodeURIComponent(body.calendar_event_id)}`
      + '&select=id&order=at.desc&limit=5',
    );
  }
  if (!existing?.[0]) {
    existing = await sb(
      `recurring_log?projection_key=eq.${encodeURIComponent(projectionKey)}`
      + '&select=id&order=at.desc&limit=5',
    );
  }
  const keepId = existing?.[0]?.id || null;
  const logBody = {
    change: pinChange,
    scheduled_date: day,
    roll_reason: 'diary_manual_pin',
    calendar_event_id: body.calendar_event_id || null,
    ideal_date: ideal,
    projection_key: projectionKey,
  };
  if (keepId) {
    await sb(`recurring_log?id=eq.${keepId}`, {
      method: 'PATCH', prefer: 'return=minimal', body: logBody,
    });
    // Drop accidental duplicates from prior double-writes
    for (const row of (existing || []).slice(1)) {
      if (row?.id) {
        await sb(`recurring_log?id=eq.${row.id}`, { method: 'DELETE', prefer: 'return=minimal' });
      }
    }
  } else {
    await sb('recurring_log', {
      method: 'POST', prefer: 'return=minimal',
      body: {
        recurring_task_id: habit.id,
        actor,
        ...logBody,
      },
    });
  }
  const action = [
    `MOVE/CREATE habit "${habit.title}" block to ${body.new_start} – ${body.new_end}.`,
    body.calendar_event_id ? `event_id=${body.calendar_event_id}` : 'Create Primary event then PATCH recurring_log.calendar_event_id',
    `ideal_date=${ideal}; scheduled_date=${day}.`,
  ].join(' ');
  const related = relatedIdForHabit(habit.id, ideal, body.calendar_event_id || null);
  await upsertPushRow(sb, {
    related_id: related,
    entity_type: 'habit',
    change_kind: 'move',
    summary: `Move habit ${habit.title} → ${day}`,
    proposed_action: action,
    payload: {
      habit_id: habit.id,
      title: habit.title,
      ideal_date: ideal,
      new_start: body.new_start,
      new_end: body.new_end,
      calendar_event_id: body.calendar_event_id || null,
    },
  });
  if (body.calendar_event_id) {
    await supersedeSiblingHabitRows(sb, {
      habitId: habit.id,
      keepRelatedId: related,
      calendarEventId: body.calendar_event_id,
      idealDate: ideal,
      scheduledDate: day,
      actor,
    });
  }
  // Idempotent pending row — patch existing related_id if still pending
  const pending = await sb(
    `pending_diary_changes?related_id=eq.${encodeURIComponent(related)}&status=eq.pending&select=id&limit=1`,
  );
  const pendingBody = {
    change_type: 'diary_manual_move',
    related_id: related,
    target_date: day,
    summary: `Diary grid: moved habit "${habit.title}" → ${day}`,
    proposed_action: action,
    reason: 'alan_diary_grid',
    urgency: 'normal',
    status: 'pending',
  };
  if (pending?.[0]?.id) {
    await sb(`pending_diary_changes?id=eq.${pending[0].id}`, {
      method: 'PATCH', prefer: 'return=minimal', body: pendingBody,
    });
  } else {
    await sb('pending_diary_changes', {
      method: 'POST', prefer: 'return=minimal', body: pendingBody,
    });
  }
  return { habit_id: habit.id, scheduled_date: day, queued: true };
}

async function setPin(taskId, pinned, actor) {
  const rows = await sb(`tasks?id=eq.${taskId}&select=id,display_id,title,slot_pinned,scheduled_start,scheduled_end,calendar_event_id`);
  const task = rows?.[0];
  if (!task) {
    const err = new Error('task not found');
    err.status = 404;
    throw err;
  }
  const patch = {
    slot_pinned: !!pinned,
    last_activity_at: new Date().toISOString(),
  };
  if (pinned) patch.slot_pinned_at = new Date().toISOString();
  await sb(`tasks?id=eq.${task.id}`, { method: 'PATCH', prefer: 'return=minimal', body: patch });
  await logChange(task.id, actor, pinned ? 'slot locked (diary)' : 'slot unlocked (diary)');
  if (!pinned) return { task_id: task.id, slot_pinned: false };
  await upsertPushRow(sb, {
    related_id: relatedIdForTask(task.id),
    entity_type: 'task',
    change_kind: 'pin',
    summary: `Pin MC-${task.display_id}`,
    proposed_action: `Ensure GCal event for MC-${task.display_id} matches DB ${task.scheduled_start}–${task.scheduled_end}`,
    payload: { task_id: task.id, display_id: task.display_id, slot_pinned: true },
  });
  return { task_id: task.id, slot_pinned: true };
}

module.exports = async function handler(req, res) {
  if (cors(req, res)) return;
  if (!envReady()) return json(res, 503, { error: 'MC_SUPABASE_NOT_CONFIGURED' });
  const session = requireAuth(req, res);
  if (!session) return;
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });

  try {
    const body = await readBody(req);
    const actor = actorFromSession(session, body);
    const action = body.action;

    if (action === 'warn') {
      const rules = await sb('scheduling_rules?select=key,value');
      const ruleMap = ruleMapFromRows(rules);
      const travel = await sb('travel_blocks?select=*');
      const awaySpans = awaySpansFromTravelBlocks(travel || [], ruleMap);
      const day = isoToLondonDate(body.new_start);
      const peers = await loadPeers(
        `${addDays(day, -1)}T00:00:00.000Z`,
        `${addDays(day, 2)}T00:00:00.000Z`,
      ).then((all) => all.filter((b) => b.id !== body.block_id));
      const result = warnDrop({
        title: body.title || 'block',
        day,
        startMin: isoToLondonMinutes(body.new_start),
        endMin: isoToLondonMinutes(body.new_end),
        peers,
        ruleMap,
        awaySpans,
        pinned: !!body.slot_pinned,
      });
      return json(res, 200, { ...result, calendar_writes: 0 });
    }

    if (action === 'move' && body.task_id) {
      const rules = await sb('scheduling_rules?select=key,value');
      const ruleMap = ruleMapFromRows(rules);
      const travel = await sb('travel_blocks?select=*');
      const awaySpans = awaySpansFromTravelBlocks(travel || [], ruleMap);
      const day = isoToLondonDate(body.new_start);
      const peers = await loadPeers(
        `${addDays(day, -1)}T00:00:00.000Z`,
        `${addDays(day, 2)}T00:00:00.000Z`,
      ).then((all) => all.filter((b) => b.id !== `task:${body.task_id}`));
      const warn = warnDrop({
        title: body.title || 'task',
        day,
        startMin: isoToLondonMinutes(body.new_start),
        endMin: isoToLondonMinutes(body.new_end),
        peers,
        ruleMap,
        awaySpans,
        pinned: false,
      });
      if (warn.blocked) return json(res, 409, warn);
      if (warn.warnings.length && !body.override) {
        return json(res, 200, { needs_override: true, ...warn, calendar_writes: 0 });
      }
      const moved = await moveTask(body, actor);
      return json(res, 200, { ...moved, warnings: warn.warnings, calendar_writes: 0 });
    }

    if (action === 'move' && body.habit_id) {
      const moved = await moveHabit(body, actor);
      return json(res, 200, { ...moved, calendar_writes: 0 });
    }

    if (action === 'unlock' && body.task_id) {
      return json(res, 200, { ...(await setPin(body.task_id, false, actor)), calendar_writes: 0 });
    }
    if (action === 'lock' && body.task_id) {
      return json(res, 200, { ...(await setPin(body.task_id, true, actor)), calendar_writes: 0 });
    }

    if (action === 'complete') {
      const today = isoToLondonDate(new Date().toISOString());
      const actualMin = body.actual_minutes != null ? Number(body.actual_minutes) : null;
      if (body.habit_id) {
        const habitId = body.habit_id;
        const scheduledDate = String(body.scheduled_date || body.completed_on || today).slice(0, 10);
        const ideal = String(body.ideal_date || scheduledDate).slice(0, 10);
        const lastDone = ideal > scheduledDate ? ideal : scheduledDate;
        const habit = (await sb(
          `recurring_tasks?id=eq.${habitId}&select=id,title,last_done,duration_min`,
        ))?.[0];
        if (!habit) return json(res, 404, { error: 'habit not found' });
        const mins = Number.isFinite(actualMin) && actualMin > 0
          ? Math.round(actualMin)
          : Number(habit.duration_min || 60);
        await sb(`recurring_tasks?id=eq.${habitId}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: {
            last_done: lastDone,
            rolls_used: 0,
            updated_at: new Date().toISOString(),
          },
        });
        const existing = await sb(
          `recurring_log?recurring_task_id=eq.${habitId}&scheduled_date=eq.${scheduledDate}`
          + '&select=id&order=at.desc&limit=1',
        );
        const logBody = {
          change: `completed ${lastDone}|actual=${mins}`,
          roll_reason: 'diary_complete',
          ideal_date: ideal,
          scheduled_date: scheduledDate,
        };
        if (existing?.[0]?.id) {
          await sb(`recurring_log?id=eq.${existing[0].id}`, {
            method: 'PATCH', prefer: 'return=minimal', body: logBody,
          });
        } else {
          await sb('recurring_log', {
            method: 'POST', prefer: 'return=minimal',
            body: {
              recurring_task_id: habitId,
              actor,
              ...logBody,
              calendar_event_id: body.calendar_event_id || null,
              projection_key: `diary-complete:${habitId}:${ideal}`,
            },
          });
        }
        const related = relatedIdForHabit(habitId, ideal, body.calendar_event_id || null);
        await upsertPushRow(sb, {
          related_id: related,
          entity_type: 'habit',
          change_kind: 'complete',
          summary: `Complete habit ${habit.title} (${mins}m actual)`,
          proposed_action: `Mark GCal event complete/shorten to ${mins}m if present; DB last_done=${lastDone}`,
          payload: {
            habit_id: habitId,
            completed_on: lastDone,
            ideal_date: ideal,
            scheduled_date: scheduledDate,
            actual_minutes: mins,
            calendar_event_id: body.calendar_event_id || null,
          },
        });
        await supersedeSiblingHabitRows(sb, {
          habitId,
          keepRelatedId: related,
          calendarEventId: body.calendar_event_id || null,
          idealDate: ideal,
          scheduledDate: scheduledDate,
          actor,
        });
        return json(res, 200, {
          habit_id: habitId,
          last_done: lastDone,
          actual_minutes: mins,
          calendar_writes: 0,
        });
      }
      const completedAt = body.completed_at || new Date().toISOString();
      // Stamp on the moment of completion (UK calendar day), not the old planned day.
      const completedOn = isoToLondonDate(completedAt) || body.completed_on || today;
      if (body.task_id || body.display_id) {
        const q = body.task_id
          ? `tasks?id=eq.${body.task_id}&select=id,display_id,title,calendar_event_id,scheduled_start,scheduled_end,est_minutes`
          : `tasks?display_id=eq.${Number(body.display_id)}&select=id,display_id,title,calendar_event_id,scheduled_start,scheduled_end,est_minutes`;
        const task = (await sb(q))?.[0];
        if (!task) return json(res, 404, { error: 'task not found' });
        const mins = Number.isFinite(actualMin) && actualMin > 0
          ? Math.round(actualMin)
          : Number(task.est_minutes || 30);
        const startMs = Date.parse(completedAt);
        const patch = {
          completed_on: completedOn,
          actual_minutes: mins,
          state: 'done',
          slot_pinned: true,
          slot_pinned_at: new Date().toISOString(),
          last_activity_at: new Date().toISOString(),
          scheduled_start: new Date(startMs).toISOString(),
          scheduled_end: new Date(startMs + mins * 60000).toISOString(),
        };
        await sb(`tasks?id=eq.${task.id}`, { method: 'PATCH', prefer: 'return=minimal', body: patch });
        await logChange(task.id, actor, `completed ${completedOn} via diary at ${patch.scheduled_start}; actual ${mins}m`);
        await upsertPushRow(sb, {
          related_id: relatedIdForTask(task.id),
          entity_type: 'task',
          change_kind: 'complete',
          summary: `Complete MC-${task.display_id} (${mins}m actual) @ ${completedOn}`,
          proposed_action: `Move/complete GCal event ${task.calendar_event_id || '(none)'} for MC-${task.display_id} to ${patch.scheduled_start}–${patch.scheduled_end} (${mins}m)`,
          payload: {
            task_id: task.id,
            display_id: task.display_id,
            completed_on: completedOn,
            completed_at: completedAt,
            actual_minutes: mins,
            scheduled_start: patch.scheduled_start,
            scheduled_end: patch.scheduled_end,
          },
        });
        return json(res, 200, {
          task_id: task.id,
          completed_on: completedOn,
          scheduled_start: patch.scheduled_start,
          scheduled_end: patch.scheduled_end,
          actual_minutes: mins,
          calendar_writes: 0,
        });
      }
    }

    if (action === 'skip' && body.habit_id) {
      const habitId = body.habit_id;
      const scheduledDate = String(body.scheduled_date || '').slice(0, 10);
      const ideal = String(body.ideal_date || scheduledDate).slice(0, 10);
      if (!scheduledDate) return json(res, 400, { error: 'scheduled_date required for skip' });
      const habit = (await sb(`recurring_tasks?id=eq.${habitId}&select=id,title`))?.[0];
      if (!habit) return json(res, 404, { error: 'habit not found' });
      // Skip this occurrence only — do NOT set last_done (next RRULE still places)
      const existing = await sb(
        `recurring_log?recurring_task_id=eq.${habitId}&scheduled_date=eq.${scheduledDate}`
        + '&select=id&order=at.desc&limit=1',
      );
      const logBody = {
        change: `skipped ${ideal}`,
        roll_reason: 'diary_skip',
        ideal_date: ideal,
        scheduled_date: scheduledDate,
      };
      if (existing?.[0]?.id) {
        await sb(`recurring_log?id=eq.${existing[0].id}`, {
          method: 'PATCH', prefer: 'return=minimal', body: logBody,
        });
      } else {
        await sb('recurring_log', {
          method: 'POST', prefer: 'return=minimal',
          body: {
            recurring_task_id: habitId,
            actor,
            ...logBody,
            calendar_event_id: body.calendar_event_id || null,
            projection_key: `diary-skip:${habitId}:${ideal}`,
          },
        });
      }
      const related = relatedIdForHabit(habitId, ideal, body.calendar_event_id || null);
      await upsertPushRow(sb, {
        related_id: related,
        entity_type: 'habit',
        change_kind: 'skip',
        summary: `Skip habit ${habit.title} occurrence ${ideal}`,
        proposed_action: `Delete/cancel GCal event for this occurrence only; next RRULE occurrence still schedules. ideal=${ideal}`,
        payload: {
          habit_id: habitId,
          ideal_date: ideal,
          scheduled_date: scheduledDate,
          calendar_event_id: body.calendar_event_id || null,
        },
      });
      await supersedeSiblingHabitRows(sb, {
        habitId,
        keepRelatedId: related,
        calendarEventId: body.calendar_event_id || null,
        idealDate: ideal,
        scheduledDate: scheduledDate,
        actor,
      });
      return json(res, 200, {
        habit_id: habitId,
        skipped: true,
        ideal_date: ideal,
        scheduled_date: scheduledDate,
        calendar_writes: 0,
      });
    }

    if (action === 'dismiss' && body.task_id) {
      const task = (await sb(`tasks?id=eq.${body.task_id}&select=id,display_id,title`))?.[0];
      if (!task) return json(res, 404, { error: 'task not found' });
      await sb(`tasks?id=eq.${task.id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: { state: 'wont_do', last_activity_at: new Date().toISOString() },
      });
      await upsertPushRow(sb, {
        related_id: relatedIdForTask(task.id),
        entity_type: 'task',
        change_kind: 'dismiss',
        summary: `Dismiss MC-${task.display_id}`,
        proposed_action: `Delete or cancel GCal event for MC-${task.display_id} if present`,
        payload: { task_id: task.id, display_id: task.display_id },
      });
      return json(res, 200, { task_id: task.id, state: 'wont_do', calendar_writes: 0 });
    }

    return json(res, 400, { error: 'action required: warn|move|lock|unlock|complete|skip|dismiss' });
  } catch (e) {
    return json(res, e.status || 500, {
      error: e.message || 'diary-action error',
      blocked: !!e.blocked,
      detail: e.data,
      calendar_writes: 0,
    });
  }
};

function addDays(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
