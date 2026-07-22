const {
  envReady, json, cors, readBody, requireAuth, actorFromSession, sb, logChange, touchActivity,
} = require('./_lib');

async function createTask(body, actor) {
  const rows = await sb('tasks', {
    method: 'POST',
    body: {
      project_id: body.project_id,
      title: body.title,
      detail_md: body.detail_md || null,
      owner: body.owner || 'alan',
      state: body.state || 'todo',
      next_step: body.next_step || null,
      why: body.why || null,
      due_date: body.due_date || null,
      waiting_on: body.waiting_on || null,
      priority: body.priority || 'p1',
      impact: body.impact || 'MEDIUM',
      difficulty: body.difficulty || 'MEDIUM',
      recurrence: body.recurrence || null,
      depends_on_task_id: body.depends_on_task_id || null,
      question_file: body.question_file || null,
      response_file: body.response_file || null,
    },
  });
  const task = Array.isArray(rows) ? rows[0] : rows;
  await logChange(task.id, actor, `created MC-${task.display_id}: ${task.title}`);
  return task;
}

async function patchTask(id, body, actor, role) {
  const curRows = await sb(`tasks?id=eq.${id}`);
  const cur = curRows?.[0];
  if (!cur) {
    const err = new Error('task not found');
    err.status = 404;
    throw err;
  }
  const patch = {};
  const fields = [
    'title', 'detail_md', 'owner', 'next_step', 'due_date', 'waiting_on', 'why',
    'priority', 'impact', 'difficulty', 'recurrence', 'depends_on_task_id', 'evidence_url',
    'question_file', 'response_file', 'project_id', 'est_minutes',
  ];
  for (const f of fields) {
    if (Object.prototype.hasOwnProperty.call(body, f)) patch[f] = body[f];
  }
  if (body.state) {
    if (body.state === 'verified') {
      const err = new Error('use /api/mc/actions verify');
      err.status = 400;
      throw err;
    }
    if (['done', 'superseded', 'wont_do'].includes(body.state)) {
      const err = new Error('use Supabase RPC mc_agent_close_task for terminal closes');
      err.status = 400;
      throw err;
    }
    if (body.state === 'done_claimed') {
      const evidence = body.evidence_url || cur.evidence_url || patch.evidence_url;
      if (!evidence) {
        const err = new Error('done_claimed requires evidence_url');
        err.status = 400;
        throw err;
      }
      patch.state = 'done_claimed';
      patch.evidence_url = evidence;
      patch.claimed_by = actor;
      patch.claimed_at = new Date().toISOString();
    } else {
      patch.state = body.state;
    }
  }
  if (role === 'agent' && body.state === 'verified') {
    const err = new Error('agent cannot verify');
    err.status = 403;
    throw err;
  }
  patch.last_activity_at = new Date().toISOString();
  const rows = await sb(`tasks?id=eq.${id}`, { method: 'PATCH', body: patch });
  const task = rows?.[0] || cur;
  await logChange(id, actor, `updated: ${Object.keys(patch).join(', ')}`);
  return task;
}

async function toggleChecklist(body, actor) {
  const id = body.checklist_id;
  const done = !!body.done;
  const rows = await sb(`checklist_items?id=eq.${id}`, { method: 'PATCH', body: { done } });
  const item = rows?.[0];
  if (item?.task_id) {
    await touchActivity(item.task_id);
    await logChange(item.task_id, actor, `checklist ${done ? 'done' : 'undone'}: ${item.label}`);
  }
  return item;
}

module.exports = async function handler(req, res) {
  if (cors(req, res)) return;
  if (!envReady()) return json(res, 503, { error: 'MC_SUPABASE_NOT_CONFIGURED' });
  const session = requireAuth(req, res);
  if (!session) return;
  try {
    if (req.method === 'POST') {
      const body = await readBody(req);
      const actor = actorFromSession(session, body);
      if (body.action === 'checklist') {
        return json(res, 200, { item: await toggleChecklist(body, actor) });
      }
      return json(res, 201, { task: await createTask(body, actor) });
    }
    if (req.method === 'PATCH') {
      const body = await readBody(req);
      const actor = actorFromSession(session, body);
      if (!body.id) return json(res, 400, { error: 'id required' });
      return json(res, 200, { task: await patchTask(body.id, body, actor, session.role) });
    }
    return json(res, 405, { error: 'method not allowed' });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message || 'task error', detail: e.data });
  }
};
