/**
 * POST /api/mc/task-completed — mark task or habit done; pin slot; no auto-verify.
 */
const { envReady, json, cors, readBody, requireAuth, actorFromSession, sb, logChange } = require('./_lib');

function isYmd(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
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
    const completedOn = body.completed_on;
    if (!isYmd(completedOn)) return json(res, 400, { error: 'completed_on YYYY-MM-DD required' });
    const source = body.source === 'calendar' ? 'calendar' : 'app';

    if (body.habit_id) {
      const rows = await sb(`recurring_tasks?id=eq.${body.habit_id}&select=id,title`);
      const habit = rows?.[0];
      if (!habit) return json(res, 404, { error: 'habit not found' });
      await sb(`recurring_tasks?id=eq.${habit.id}`, {
        method: 'PATCH',
        prefer: 'return=minimal',
        body: { last_done: completedOn, updated_at: new Date().toISOString() },
      });
      await sb('recurring_log', {
        method: 'POST',
        prefer: 'return=minimal',
        body: {
          recurring_task_id: habit.id,
          actor,
          change: `completed ${completedOn} via ${source}`,
          scheduled_date: completedOn,
          calendar_event_id: body.calendar_event_id || null,
        },
      });
      return json(res, 200, { habit_id: habit.id, last_done: completedOn, source });
    }

    const did = Number(body.display_id);
    if (!Number.isInteger(did)) return json(res, 400, { error: 'display_id or habit_id required' });
    const rows = await sb(`tasks?display_id=eq.${did}&select=id,display_id,state`);
    const task = rows?.[0];
    if (!task) return json(res, 404, { error: 'task not found' });
    const patch = {
      completed_on: completedOn,
      slot_pinned: true,
      slot_pinned_at: new Date().toISOString(),
      last_activity_at: new Date().toISOString(),
    };
    if (body.calendar_event_id) patch.calendar_event_id = body.calendar_event_id;
    await sb(`tasks?id=eq.${task.id}`, { method: 'PATCH', prefer: 'return=minimal', body: patch });
    await logChange(task.id, actor, `completed ${completedOn} via ${source}; slot pinned`);
    return json(res, 200, {
      display_id: did,
      completed_on: completedOn,
      slot_pinned: true,
      source,
      verified: false,
    });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message || 'task-completed error', detail: e.data });
  }
};
