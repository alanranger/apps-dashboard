/**
 * Shared habit complete: last_done + log + GCal queue (occurrence, not date-stamp only).
 */
const {
  relatedIdForHabit, upsertPushRow, supersedeSiblingHabitRows,
} = require('./gcal-push-lib');
const { isoToLondonDate } = require('./scheduling-rules-lib');
const { retireGapBuffersAfter } = require('./buffer-gap-lib');
const { lastDueOnOrBefore } = require('./rrule-core');

function isSkippedChange(change) {
  return /^skipped\b/i.test(String(change || ''));
}

function isCompletedChange(change) {
  return /^completed\s/i.test(String(change || ''));
}

async function completeHabitOccurrence(sb, opts) {
  const habitId = opts.habitId;
  const actor = opts.actor || 'cursor';
  const completedAt = opts.completedAt || new Date().toISOString();
  const completedOn = isoToLondonDate(completedAt)
    || isoToLondonDate(new Date().toISOString());
  const habit = (await sb(
    `recurring_tasks?id=eq.${habitId}&select=id,title,last_done,duration_min`,
  ))?.[0];
  if (!habit) {
    const err = new Error('habit not found');
    err.status = 404;
    throw err;
  }
  const mins = Number(opts.actualMinutes) > 0
    ? Math.round(Number(opts.actualMinutes))
    : Number(habit.duration_min || 60);
  const startMs = Date.parse(completedAt);
  const scheduledStart = new Date(startMs).toISOString();
  const scheduledEnd = new Date(startMs + mins * 60000).toISOString();
  const ideal = String(opts.idealDate || completedOn).slice(0, 10);
  const evtId = opts.calendarEventId || null;

  await sb(`recurring_tasks?id=eq.${habitId}`, {
    method: 'PATCH', prefer: 'return=minimal',
    body: {
      last_done: completedOn,
      rolls_used: 0,
      updated_at: new Date().toISOString(),
    },
  });

  let existing = await sb(
    `recurring_log?recurring_task_id=eq.${habitId}&ideal_date=eq.${ideal}`
    + '&select=id&order=at.desc&limit=1',
  );
  if (!existing?.[0]?.id && evtId) {
    existing = await sb(
      `recurring_log?recurring_task_id=eq.${habitId}&calendar_event_id=eq.${evtId}`
      + '&select=id&order=at.desc&limit=1',
    );
  }
  const logBody = {
    change: `completed ${completedOn}|actual=${mins}|at=${scheduledStart}`,
    roll_reason: opts.rollReason || 'habit_complete',
    ideal_date: ideal,
    scheduled_date: completedOn,
    calendar_event_id: evtId,
    at: new Date().toISOString(),
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
        projection_key: `habit-complete:${habitId}:${ideal}`,
      },
    });
  }

  const related = relatedIdForHabit(habitId, ideal, evtId);
  await retireGapBuffersAfter(sb, upsertPushRow, {
    afterEventId: evtId,
    labelHints: [habit.title],
  });
  await upsertPushRow(sb, {
    related_id: related,
    entity_type: 'habit',
    change_kind: 'complete',
    summary: `Complete habit ${habit.title} (${mins}m actual) @ ${completedOn}`,
    proposed_action: evtId
      ? `Move GCal event ${evtId} to ${scheduledStart}–${scheduledEnd}`
      : `Create GCal event at ${scheduledStart}–${scheduledEnd}`,
    payload: {
      habit_id: habitId,
      title: habit.title,
      completed_on: completedOn,
      ideal_date: ideal,
      scheduled_date: completedOn,
      actual_minutes: mins,
      scheduled_start: scheduledStart,
      scheduled_end: scheduledEnd,
      calendar_event_id: evtId,
    },
  });
  await supersedeSiblingHabitRows(sb, {
    habitId,
    keepRelatedId: related,
    calendarEventId: evtId,
    idealDate: ideal,
    scheduledDate: completedOn,
    actor,
  });
  return {
    habit_id: habitId,
    last_done: completedOn,
    actual_minutes: mins,
    scheduled_start: scheduledStart,
    scheduled_end: scheduledEnd,
    ideal_date: ideal,
    calendar_event_id: evtId,
  };
}

async function findOccurrenceToComplete(sb, task) {
  const today = isoToLondonDate(new Date().toISOString())
    || new Date().toISOString().slice(0, 10);
  let due = null;
  try {
    due = lastDueOnOrBefore(task.rrule, today);
  } catch (_) {
    due = null;
  }
  const logs = await sb(
    `recurring_log?recurring_task_id=eq.${task.id}`
    + '&select=id,change,ideal_date,scheduled_date,calendar_event_id,at'
    + '&order=at.desc&limit=80',
  ) || [];
  const latestFor = (ideal) => logs.find((l) => l.ideal_date === ideal) || null;
  if (!due) return { ideal: today, log: null, today };
  const log = latestFor(due);
  const ch = log?.change || '';
  if (isSkippedChange(ch)) return null;
  const leftoverEvt = logs.find((l) => (
    l.calendar_event_id
    && !isSkippedChange(l.change)
    && !isCompletedChange(l.change)
    && (!l.ideal_date || l.ideal_date === due)
  ));
  if (leftoverEvt) return { ideal: due, log: leftoverEvt, today };
  if (isCompletedChange(ch) || /^marked done\b/i.test(ch)) return null;
  return { ideal: due, log: log || null, today };
}

module.exports = {
  completeHabitOccurrence,
  findOccurrenceToComplete,
};
