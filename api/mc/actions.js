const {
  envReady, json, cors, readBody, requireAuth, actorFromSession,
  sb, logChange, spawnRecurrence,
} = require('./_lib');

async function verify(taskId, session) {
  if (session.role !== 'alan') {
    const err = new Error('verify is available on Alan\'s login only');
    err.status = 403;
    throw err;
  }
  const rows = await sb(`tasks?id=eq.${taskId}`);
  const task = rows?.[0];
  if (!task) {
    const err = new Error('task not found');
    err.status = 404;
    throw err;
  }
  if (task.state !== 'done_claimed') {
    const err = new Error('only done_claimed tasks can be verified');
    err.status = 400;
    throw err;
  }
  const updated = await sb(`tasks?id=eq.${taskId}`, {
    method: 'PATCH',
    body: {
      state: 'verified',
      verified_at: new Date().toISOString(),
      last_activity_at: new Date().toISOString(),
      sent_back_note: null,
    },
  });
  await logChange(taskId, 'alan', 'verified');
  await spawnRecurrence(task, 'alan');
  return updated?.[0];
}

async function sendBack(taskId, note, session) {
  if (session.role !== 'alan') {
    const err = new Error('send back requires Alan role');
    err.status = 403;
    throw err;
  }
  const trimmed = String(note || '').trim();
  if (!trimmed) {
    const err = new Error('send back requires a note');
    err.status = 400;
    throw err;
  }
  const rows = await sb(`tasks?id=eq.${taskId}`);
  const task = rows?.[0];
  if (!task) {
    const err = new Error('task not found');
    err.status = 404;
    throw err;
  }
  if (task.state !== 'done_claimed') {
    const err = new Error('only done_claimed tasks can be sent back');
    err.status = 400;
    throw err;
  }
  const updated = await sb(`tasks?id=eq.${taskId}`, {
    method: 'PATCH',
    body: {
      state: 'in_progress',
      sent_back_note: trimmed,
      claimed_by: null,
      claimed_at: null,
      last_activity_at: new Date().toISOString(),
    },
  });
  await sb('task_comments', {
    method: 'POST',
    body: {
      task_id: taskId,
      author: 'alan',
      body_md: trimmed,
      kind: 'send-back',
      image_urls: [],
    },
  });
  await logChange(taskId, 'alan', `sent back: ${trimmed}`);
  return updated?.[0];
}

module.exports = async function handler(req, res) {
  if (cors(req, res)) return;
  if (!envReady()) return json(res, 503, { error: 'MC_SUPABASE_NOT_CONFIGURED' });
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
  const session = requireAuth(req, res);
  if (!session) return;
  try {
    const body = await readBody(req);
    if (!body.task_id) return json(res, 400, { error: 'task_id required' });
    if (body.action === 'verify') {
      return json(res, 200, { task: await verify(body.task_id, session) });
    }
    if (body.action === 'send_back') {
      return json(res, 200, { task: await sendBack(body.task_id, body.note, session) });
    }
    return json(res, 400, { error: 'unknown action' });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message || 'action failed', detail: e.data });
  }
};
