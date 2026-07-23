const { envReady, json, cors, requireAuth, sb } = require('./_lib');

async function safeSb(path) {
  try {
    return await sb(path);
  } catch (e) {
    return [];
  }
}

module.exports = async function handler(req, res) {
  if (cors(req, res)) return;
  if (!envReady()) return json(res, 503, { error: 'MC_SUPABASE_NOT_CONFIGURED' });
  if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
  const session = requireAuth(req, res);
  if (!session) return;
  try {
    const [projects, tasks, checklist, comments, log, recurring, recurring_log, reconcile_log, recurring_deps] = await Promise.all([
      sb('projects?active=eq.true&order=sort.asc'),
      sb('tasks?select=*,depends_on:depends_on_task_id(display_id,title)&order=display_id.asc'),
      sb('checklist_items?order=sort.asc'),
      sb('task_comments?order=at.desc&limit=400'),
      sb('task_log?order=at.desc&limit=500'),
      safeSb('recurring_tasks?order=title.asc'),
      safeSb('recurring_log?order=at.desc&limit=200'),
      safeSb('mc_reconcile_log?order=run_at.desc&limit=20'),
      safeSb('recurring_task_deps?select=*&order=created_at.asc'),
    ]);
    return json(res, 200, {
      role: session.role, projects, tasks, checklist, comments, log, recurring, recurring_log, reconcile_log, recurring_deps,
    });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message || 'bootstrap failed', detail: e.data });
  }
};
