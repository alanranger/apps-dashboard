const {
  envReady, json, cors, readBody, requireAuth, actorFromSession, sb,
} = require('./_lib');
const { idealsInHorizon, lastDueOnOrBefore } = require('./rrule-core');
const { isoToLondonDate } = require('./scheduling-rules-lib');
const {
  relatedIdForHabit, upsertPushRow, supersedeSiblingHabitRows,
} = require('./gcal-push-lib');
const { autoSyncIfAllowed } = require('./gcal-auto-sync-lib');
const { retireGapBuffersAfter } = require('./buffer-gap-lib');
const { completeHabitOccurrence, findOccurrenceToComplete } = require('./habit-complete-lib');

function addDaysYmd(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function isSkippedChange(change) {
  return /^skipped\b/i.test(String(change || ''));
}

function isDoneChange(change) {
  return /^completed\s|^marked done\b/i.test(String(change || ''));
}

/**
 * First upcoming ideal (>= today) that is not done/skipped.
 * Must use idealsInHorizon (phase-anchored) — plain occurrencesInRange from
 * "today" flips bi-monthly INTERVAL=2 onto the wrong Mondays (e.g. Sep 28
 * instead of Aug 24), so Skip Next would miss the Occurrences list pill.
 */
async function nextOpenOccurrence(task) {
  const today = isoToLondonDate(new Date().toISOString()) || new Date().toISOString().slice(0, 10);
  const to = addDaysYmd(today, 180);
  let ideals = [];
  try {
    const phaseAnchor = lastDueOnOrBefore(task.rrule, addDaysYmd(today, -1)) || today;
    ideals = idealsInHorizon(task.rrule, today, to, 200, phaseAnchor);
  } catch (_) {
    ideals = [];
  }
  if (!ideals.length) return null;

  const logs = await sb(
    `recurring_log?recurring_task_id=eq.${task.id}&ideal_date=gte.${today}`
    + '&select=id,change,ideal_date,scheduled_date,calendar_event_id,at&order=at.desc&limit=80',
  ) || [];
  const latestByIdeal = new Map();
  for (const l of logs) {
    if (!l.ideal_date || latestByIdeal.has(l.ideal_date)) continue;
    latestByIdeal.set(l.ideal_date, l);
  }

  for (const ideal of ideals) {
    if (task.last_done && task.last_done >= ideal) continue;
    const log = latestByIdeal.get(ideal);
    if (log && (isSkippedChange(log.change) || isDoneChange(log.change))) continue;
    return { ideal, log: log || null, today };
  }
  return null;
}

async function logRecurring(taskId, actor, change) {
  await sb('recurring_log', { method: 'POST', body: { recurring_task_id: taskId, actor, change } });
}

async function touchRecurring(id) {
  await sb(`recurring_tasks?id=eq.${id}`, {
    method: 'PATCH',
    body: { updated_at: new Date().toISOString() },
  });
}

async function createRecurring(body, actor) {
  const rows = await sb('recurring_tasks', {
    method: 'POST',
    body: {
      title: body.title,
      cadence_text: body.cadence_text,
      rrule: body.rrule,
      duration_min: body.duration_min || 60,
      ideal_time: body.ideal_time || '09:00',
      window_days: body.window_days != null ? body.window_days : 2,
      priority: body.priority || 'p1',
      time_critical: body.time_critical === true,
      notes_md: body.notes_md || null,
      scheduled_note: body.scheduled_note || null,
      active: body.active !== false,
    },
  });
  const row = Array.isArray(rows) ? rows[0] : rows;
  await logRecurring(row.id, actor, `created: ${row.title}`);
  return row;
}

/**
 * After RRULE / phase re-anchor: skip future open pins whose ideal is no longer
 * on the series. Keeps done/skipped history.
 */
async function cullObsoleteFuturePins(task, actor) {
  const today = isoToLondonDate(new Date().toISOString()) || new Date().toISOString().slice(0, 10);
  const to = addDaysYmd(today, 400);
  const keep = new Set(idealsInHorizon(task.rrule, today, to, 200) || []);
  const logs = await sb(
    `recurring_log?recurring_task_id=eq.${task.id}&ideal_date=gte.${today}`
    + '&select=id,change,ideal_date,scheduled_date,calendar_event_id,at&order=at.desc&limit=120',
  ) || [];
  const latestByIdeal = new Map();
  for (const l of logs) {
    if (!l.ideal_date || latestByIdeal.has(l.ideal_date)) continue;
    latestByIdeal.set(l.ideal_date, l);
  }
  const culled = [];
  for (const [ideal, log] of latestByIdeal) {
    if (keep.has(ideal)) continue;
    if (isDoneChange(log.change) || isSkippedChange(log.change)) continue;
    if (!/^diary_pin:|^unplaced/i.test(String(log.change || '')) && log.change) continue;
    const evtId = log.calendar_event_id || null;
    const note = `skipped occurrence ${ideal}: reanchor_phase`;
    await sb(`recurring_log?id=eq.${log.id}`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: {
        change: note,
        ideal_date: ideal,
        scheduled_date: log.scheduled_date || ideal,
        calendar_event_id: evtId,
        roll_reason: 'reanchor_phase',
        at: new Date().toISOString(),
      },
    });
    if (evtId) {
      const related = relatedIdForHabit(task.id, ideal, evtId);
      await upsertPushRow(sb, {
        related_id: related,
        entity_type: 'habit',
        change_kind: 'skip',
        summary: `Re-anchor cull: ${task.title} (${ideal})`,
        proposed_action: `Delete/cancel GCal event ${evtId} — ideal dropped after re-anchor.`,
        payload: {
          habit_id: task.id,
          ideal_date: ideal,
          scheduled_date: log.scheduled_date || ideal,
          calendar_event_id: evtId,
          action: 'delete_event',
        },
      });
    }
    culled.push(ideal);
  }
  return culled;
}

async function patchRecurring(id, body, actor) {
  const curRows = await sb(`recurring_tasks?id=eq.${id}`);
  const cur = curRows?.[0];
  if (!cur) {
    const err = new Error('recurring task not found');
    err.status = 404;
    throw err;
  }
  const patch = { updated_at: new Date().toISOString() };
  const fields = [
    'title', 'cadence_text', 'rrule', 'duration_min', 'ideal_time', 'window_days', 'priority',
    'time_critical', 'notes_md', 'scheduled_note', 'active', 'last_scheduled', 'last_done',
  ];
  for (const f of fields) {
    if (Object.prototype.hasOwnProperty.call(body, f)) patch[f] = body[f];
  }
  const rows = await sb(`recurring_tasks?id=eq.${id}`, { method: 'PATCH', body: patch });
  const row = rows?.[0] || cur;
  await logRecurring(id, actor, `updated: ${Object.keys(patch).filter((k) => k !== 'updated_at').join(', ')}`);
  let culled_ideals = [];
  if (body.cull_obsolete_pins === true || body.reanchor_ymd) {
    culled_ideals = await cullObsoleteFuturePins(row, actor);
    if (culled_ideals.length) {
      await logRecurring(id, actor, `reanchor cull: ${culled_ideals.join(', ')}`);
      try {
        await autoSyncIfAllowed(sb, actor || 'recurring-reanchor');
      } catch (_) { /* non-fatal */ }
    }
  }
  return { ...row, culled_ideals };
}

async function markDone(id, actor) {
  const curRows = await sb(
    `recurring_tasks?id=eq.${id}&select=id,title,rrule,last_done,duration_min`,
  );
  const cur = curRows?.[0];
  if (!cur) {
    const err = new Error('recurring task not found');
    err.status = 404;
    throw err;
  }
  const occ = await findOccurrenceToComplete(sb, cur);
  if (!occ?.ideal) {
    const err = new Error('this occurrence is already marked done');
    err.status = 400;
    throw err;
  }
  const evtId = occ.log?.calendar_event_id || null;
  const result = await completeHabitOccurrence(sb, {
    habitId: id,
    actor,
    idealDate: occ.ideal,
    scheduledDate: occ.log?.scheduled_date || occ.ideal,
    calendarEventId: evtId,
    completedAt: new Date().toISOString(),
    actualMinutes: cur.duration_min,
    rollReason: 'recurring_mark_done',
  });
  let calendar_sync = { skipped: true, reason: 'no_event' };
  try {
    calendar_sync = await autoSyncIfAllowed(sb, actor || 'recurring-mark-done');
  } catch (e) {
    calendar_sync = { skipped: true, error: e.message };
  }
  return {
    ...cur,
    ...result,
    last_done: result.last_done,
    calendar_writes: calendar_sync.skipped ? 0 : Number(calendar_sync.flush?.applied || 0),
    calendar_sync,
  };
}

/**
 * Skip Next — first open upcoming occurrence in the Recurring queue.
 * Logs skipped, queues GCal delete when an event exists, auto-syncs.
 * Never writes last_done (later RRULE dates still schedule).
 */
async function skipOccurrence(id, actor, reason) {
  const curRows = await sb(
    `recurring_tasks?id=eq.${id}&select=id,title,rrule,last_done,rolls_used`,
  );
  const cur = curRows?.[0];
  if (!cur) {
    const err = new Error('recurring task not found');
    err.status = 404;
    throw err;
  }
  const next = await nextOpenOccurrence(cur);
  if (!next?.ideal) {
    const err = new Error('no upcoming occurrence to skip');
    err.status = 400;
    throw err;
  }
  const occurrenceDate = next.ideal;
  const existing = next.log;
  const evtId = existing?.calendar_event_id || null;
  const note = reason
    ? `skipped occurrence ${occurrenceDate}: ${reason}`
    : `skipped occurrence ${occurrenceDate}`;

  await sb(`recurring_tasks?id=eq.${id}`, {
    method: 'PATCH', prefer: 'return=minimal',
    body: { updated_at: new Date().toISOString() },
  });

  const logBody = {
    change: note,
    ideal_date: occurrenceDate,
    scheduled_date: existing?.scheduled_date || occurrenceDate,
    calendar_event_id: evtId,
    roll_reason: 'recurring_skip_next',
    at: new Date().toISOString(),
  };
  if (existing?.id) {
    await sb(`recurring_log?id=eq.${existing.id}`, {
      method: 'PATCH', prefer: 'return=minimal', body: logBody,
    });
  } else {
    await sb('recurring_log', {
      method: 'POST', prefer: 'return=minimal',
      body: {
        recurring_task_id: id,
        actor,
        ...logBody,
        projection_key: `recurring-skip:${id}:${occurrenceDate}`,
      },
    });
  }

  // Clear UNSCHEDULED / missed pending for this ideal if present.
  try {
    const relatedIds = [
      `habit_unplaced:${id}:${occurrenceDate}`,
      `habit:${id}:${occurrenceDate}`,
    ];
    for (const rid of relatedIds) {
      const pending = await sb(
        `pending_diary_changes?status=eq.pending&related_id=eq.${encodeURIComponent(rid)}&select=id`,
      ) || [];
      for (const p of pending) {
        await sb(`pending_diary_changes?id=eq.${p.id}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: {
            status: 'resolved_externally',
            resolved_at: new Date().toISOString(),
            resolved_by: 'recurring_skip_next',
          },
        });
      }
    }
  } catch (_) { /* non-fatal */ }

  const related = relatedIdForHabit(id, occurrenceDate, evtId);
  if (evtId) {
    await retireGapBuffersAfter(sb, upsertPushRow, {
      afterEventId: evtId,
      labelHints: [cur.title],
    });
  }
  await upsertPushRow(sb, {
    related_id: related,
    entity_type: 'habit',
    change_kind: 'skip',
    summary: `Skip next: ${cur.title} (${occurrenceDate})`,
    proposed_action: evtId
      ? `Delete/cancel GCal event ${evtId} for this occurrence only; later RRULE dates still schedule.`
      : `No GCal event for ${occurrenceDate} — log skipped only; later RRULE dates still schedule.`,
    payload: {
      habit_id: id,
      ideal_date: occurrenceDate,
      scheduled_date: existing?.scheduled_date || occurrenceDate,
      calendar_event_id: evtId,
      action: evtId ? 'delete_event' : undefined,
    },
  });
  await supersedeSiblingHabitRows(sb, {
    habitId: id,
    keepRelatedId: related,
    calendarEventId: evtId,
    idealDate: occurrenceDate,
    scheduledDate: existing?.scheduled_date || occurrenceDate,
    actor,
  });

  let calendar_sync = { skipped: true, reason: 'no_event' };
  if (evtId) {
    try {
      calendar_sync = await autoSyncIfAllowed(sb, actor || 'recurring-skip');
    } catch (e) {
      calendar_sync = { skipped: true, error: e.message };
    }
  }

  return {
    ...cur,
    skipped_occurrence: occurrenceDate,
    calendar_event_id: evtId,
    calendar_writes: calendar_sync.skipped ? 0 : Number(calendar_sync.flush?.applied || 0),
    calendar_sync,
  };
}

module.exports = async function handler(req, res) {
  if (cors(req, res)) return;
  if (!envReady()) return json(res, 503, { error: 'MC_SUPABASE_NOT_CONFIGURED' });
  const session = requireAuth(req, res);
  if (!session) return;
  try {
    const body = req.method === 'GET' ? {} : await readBody(req);
    const actor = actorFromSession(session, body);

    if (req.method === 'GET') {
      const [tasks, log] = await Promise.all([
        sb('recurring_tasks?order=title.asc'),
        sb('recurring_log?order=at.desc&limit=200'),
      ]);
      return json(res, 200, { recurring: tasks, recurring_log: log });
    }

    if (req.method === 'POST') {
      if (body.action === 'mark_done') {
        if (!body.id) return json(res, 400, { error: 'id required' });
        return json(res, 200, { task: await markDone(body.id, actor) });
      }
      if (body.action === 'skip') {
        if (!body.id) return json(res, 400, { error: 'id required' });
        return json(res, 200, { task: await skipOccurrence(body.id, actor, body.reason) });
      }
      return json(res, 201, { task: await createRecurring(body, actor) });
    }

    if (req.method === 'PATCH') {
      if (!body.id) return json(res, 400, { error: 'id required' });
      const task = await patchRecurring(body.id, body, actor);
      await touchRecurring(body.id);
      return json(res, 200, { task });
    }

    return json(res, 405, { error: 'method not allowed' });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message || 'recurring error', detail: e.data });
  }
};
