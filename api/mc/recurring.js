const {
  envReady, json, cors, readBody, requireAuth, actorFromSession, sb,
} = require('./_lib');

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
      notes_md: body.notes_md || null,
      scheduled_note: body.scheduled_note || null,
      active: body.active !== false,
    },
  });
  const row = Array.isArray(rows) ? rows[0] : rows;
  await logRecurring(row.id, actor, `created: ${row.title}`);
  return row;
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
    'title', 'cadence_text', 'rrule', 'duration_min', 'ideal_time', 'window_days',
    'notes_md', 'scheduled_note', 'active', 'last_scheduled', 'last_done',
  ];
  for (const f of fields) {
    if (Object.prototype.hasOwnProperty.call(body, f)) patch[f] = body[f];
  }
  const rows = await sb(`recurring_tasks?id=eq.${id}`, { method: 'PATCH', body: patch });
  const row = rows?.[0] || cur;
  await logRecurring(id, actor, `updated: ${Object.keys(patch).filter((k) => k !== 'updated_at').join(', ')}`);
  return row;
}

async function markDone(id, actor) {
  const today = new Date().toISOString().slice(0, 10);
  const rows = await sb(`recurring_tasks?id=eq.${id}`, {
    method: 'PATCH',
    body: { last_done: today, rolls_used: 0, updated_at: new Date().toISOString() },
  });
  const row = rows?.[0];
  if (!row) {
    const err = new Error('recurring task not found');
    err.status = 404;
    throw err;
  }
  await logRecurring(id, actor, `marked done ${today}`);
  return row;
}

/** Skip this occurrence — only Alan-sanctioned clear without "done". Advances last_done to today. */
async function skipOccurrence(id, actor, reason) {
  const today = new Date().toISOString().slice(0, 10);
  const rows = await sb(`recurring_tasks?id=eq.${id}`, {
    method: 'PATCH',
    body: { last_done: today, rolls_used: 0, updated_at: new Date().toISOString() },
  });
  const row = rows?.[0];
  if (!row) {
    const err = new Error('recurring task not found');
    err.status = 404;
    throw err;
  }
  const note = reason ? `skipped occurrence ${today}: ${reason}` : `skipped occurrence ${today}`;
  await logRecurring(id, actor, note);
  return row;
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
