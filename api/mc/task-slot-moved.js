/**
 * POST /api/mc/task-slot-moved — pin manual calendar move; NEVER touches due_date.
 */
const { envReady, json, cors, readBody, requireAuth, actorFromSession, sb, logChange } = require('./_lib');

module.exports = async function handler(req, res) {
  if (cors(req, res)) return;
  if (!envReady()) return json(res, 503, { error: 'MC_SUPABASE_NOT_CONFIGURED' });
  const session = requireAuth(req, res);
  if (!session) return;
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
  try {
    const body = await readBody(req);
    const actor = actorFromSession(session, body);
    const did = Number(body.display_id);
    if (!Number.isInteger(did)) return json(res, 400, { error: 'display_id required' });
    const rows = await sb(`tasks?display_id=eq.${did}&select=id,display_id,due_date,slot_pinned`);
    const task = rows?.[0];
    if (!task) return json(res, 404, { error: 'task not found' });
    const patch = {
      scheduled_start: body.new_start,
      scheduled_end: body.new_end,
      slot_pinned: true,
      slot_pinned_at: new Date().toISOString(),
      slot_pinned_from: body.old_start || null,
      last_activity_at: new Date().toISOString(),
    };
    if (body.calendar_event_id) patch.calendar_event_id = body.calendar_event_id;
    await sb(`tasks?id=eq.${task.id}`, { method: 'PATCH', prefer: 'return=minimal', body: patch });
    await logChange(task.id, actor, `slot pinned: ${body.old_start || '?'} → ${body.new_start}`);
    try {
      await sb('mc_reconcile_log', {
        method: 'POST',
        prefer: 'return=minimal',
        body: {
          display_id: did,
          old_due_date: task.due_date,
          new_due_date: task.due_date,
          result: 'slot_pinned',
          source: 'task-slot-moved',
          calendar_event_id: body.calendar_event_id || null,
        },
      });
    } catch (e) { /* best effort */ }
    return json(res, 200, {
      display_id: did,
      due_date: task.due_date,
      slot_pinned: true,
      scheduled_start: body.new_start,
      scheduled_end: body.new_end,
    });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message || 'task-slot-moved error', detail: e.data });
  }
};
