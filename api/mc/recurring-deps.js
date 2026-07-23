/**
 * Habit dependency CRUD (recurring_task_deps).
 *
 * Enforces the constraints the DB alone cannot: no self-dependency, within_hours
 * required for that type, and — crucially — rejects any edge that would create a
 * cycle (A depends on B depends on … back to A). The scheduler (Claude) reads the
 * resulting graph via /api/mc/habit-projection.json and honours it when placing.
 */
const {
  envReady, json, cors, readBody, requireAuth, actorFromSession, sb,
} = require('./_lib');

const DEP_TYPES = ['must_complete_first', 'same_day_after', 'within_hours'];

async function logDep(habitId, actor, change) {
  try {
    await sb('recurring_log', { method: 'POST', body: { recurring_task_id: habitId, actor, change } });
  } catch { /* logging is best-effort — never fail the write on a log hiccup */ }
}

function buildAdjacency(edges) {
  const adj = new Map();
  for (const e of edges) {
    if (!adj.has(e.habit_id)) adj.set(e.habit_id, []);
    adj.get(e.habit_id).push(e.depends_on_habit_id);
  }
  return adj;
}

/** True if a dependency path already runs from `start` to `target`. */
function pathExists(edges, start, target) {
  const adj = buildAdjacency(edges);
  const seen = new Set();
  const stack = [start];
  while (stack.length) {
    const node = stack.pop();
    if (node === target) return true;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const next of adj.get(node) || []) stack.push(next);
  }
  return false;
}

function validateCreate(body) {
  if (!body.habit_id || !body.depends_on_habit_id) return 'habit_id and depends_on_habit_id are required';
  if (body.habit_id === body.depends_on_habit_id) return 'a habit cannot depend on itself';
  if (!DEP_TYPES.includes(body.dep_type)) return `dep_type must be one of ${DEP_TYPES.join(', ')}`;
  const wh = Number(body.within_hours);
  if (body.dep_type === 'within_hours' && (!Number.isFinite(wh) || wh <= 0)) {
    return 'within_hours (a positive number) is required when dep_type is within_hours';
  }
  return null;
}

function fail(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}

async function createDep(body, actor) {
  const problem = validateCreate(body);
  if (problem) throw fail(problem, 400);
  const existing = await sb('recurring_task_deps?select=habit_id,depends_on_habit_id');
  // Adding habit -> blocker forms a cycle iff blocker already reaches habit.
  if (pathExists(existing || [], body.depends_on_habit_id, body.habit_id)) {
    throw fail('that dependency would create a cycle', 400);
  }
  const rows = await sb('recurring_task_deps', {
    method: 'POST',
    body: {
      habit_id: body.habit_id,
      depends_on_habit_id: body.depends_on_habit_id,
      dep_type: body.dep_type,
      within_hours: body.dep_type === 'within_hours' ? Number(body.within_hours) : null,
      notes: body.notes || null,
    },
  });
  const row = Array.isArray(rows) ? rows[0] : rows;
  await logDep(body.habit_id, actor, `dependency added: ${body.dep_type} on ${body.depends_on_habit_id}`);
  return row;
}

async function deleteDep(id, actor) {
  const curRows = await sb(`recurring_task_deps?id=eq.${id}&select=habit_id,depends_on_habit_id,dep_type`);
  const cur = curRows?.[0];
  if (!cur) throw fail('dependency not found', 404);
  await sb(`recurring_task_deps?id=eq.${id}`, { method: 'DELETE', prefer: 'return=minimal' });
  await logDep(cur.habit_id, actor, `dependency removed: ${cur.dep_type} on ${cur.depends_on_habit_id}`);
  return { id, removed: true };
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
      return json(res, 200, { deps: await sb('recurring_task_deps?select=*&order=created_at.asc') });
    }
    if (req.method === 'POST') {
      if (body.action === 'delete') {
        if (!body.id) return json(res, 400, { error: 'id required' });
        return json(res, 200, await deleteDep(body.id, actor));
      }
      return json(res, 201, { dep: await createDep(body, actor) });
    }
    return json(res, 405, { error: 'method not allowed' });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message || 'recurring-deps error', detail: e.data });
  }
};
