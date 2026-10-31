/**
 * Update-all API (state only — the runner on Alan's PC executes the steps).
 *   GET  /api/update-all?run=latest|<id>     → { run, steps, registry }
 *   GET  /api/update-all?runs=10             → recent runs
 *   POST { action: 'start', mode: 'dry', include_audit } → request a run (live refused until UPDATE_ALL_LIVE_ENABLED=1 and role alan);
 *                                            include_audit (default true) decides whether step 13 (① full audit) runs
 *   POST { action: 'resume', run_id }        → re-request a failed run from its failed step
 *   POST { action: 'cancel', run_id }
 * Auth: Mission Control session token (same login as the dashboard).
 */
const { json, cors, readBody, requireAuth, sb } = require('./mc/_lib');
const REGISTRY = require('../runner/steps.json');

const ACTIVE = 'status=in.(requested,running)';

async function latestRun(id) {
  const q = id && id !== 'latest' ? `update_all_runs?id=eq.${encodeURIComponent(id)}` : 'update_all_runs?order=requested_at.desc&limit=1';
  const run = (await sb(q))[0] || null;
  const steps = run ? await sb(`update_all_steps?run_id=eq.${run.id}&order=ord.asc`) : [];
  return { run, steps, registry: REGISTRY };
}

async function start(session, body) {
  const mode = body.mode === 'live' ? 'live' : 'dry';
  if (mode === 'live' && (process.env.UPDATE_ALL_LIVE_ENABLED !== '1' || session.role !== 'alan')) {
    return [403, { error: 'LIVE mode is not enabled yet' }];
  }
  const active = await sb(`update_all_runs?${ACTIVE}&limit=1`);
  if (active.length) return [409, { error: 'a run is already requested or running', run: active[0] }];
  const run = (await sb('update_all_runs', { method: 'POST',
    body: { mode, status: 'requested', requested_by: session.role, include_audit: body.include_audit !== false } }))[0];
  return [200, { run }];
}

async function resume(body) {
  const steps = await sb(`update_all_steps?run_id=eq.${encodeURIComponent(body.run_id)}&order=ord.asc`);
  const failed = steps.find((s) => s.status === 'fail' || s.status === 'running');
  if (!failed) return [400, { error: 'nothing to resume' }];
  const run = (await sb(`update_all_runs?id=eq.${encodeURIComponent(body.run_id)}`, { method: 'PATCH',
    body: { status: 'requested', resume_from: failed.step_id, error: null, finished_at: null } }))[0];
  return [200, { run, resume_from: failed.step_id }];
}

async function cancel(body) {
  const run = (await sb(`update_all_runs?id=eq.${encodeURIComponent(body.run_id)}&${ACTIVE}`, { method: 'PATCH',
    body: { status: 'cancelled', finished_at: new Date().toISOString() } }))[0];
  return run ? [200, { run }] : [400, { error: 'run is not active' }];
}

const ACTIONS = { start: (s, b) => start(s, b), resume: (s, b) => resume(b), cancel: (s, b) => cancel(b) };

module.exports = async function handler(req, res) {
  if (cors(req, res)) return;
  const session = requireAuth(req, res);
  if (!session) return;
  try {
    if (req.method === 'GET') {
      const url = new URL(req.url, 'http://x');
      if (url.searchParams.get('runs')) return json(res, 200, { runs: await sb(`update_all_runs?order=requested_at.desc&limit=${Math.min(50, Number(url.searchParams.get('runs')) || 10)}`) });
      return json(res, 200, await latestRun(url.searchParams.get('run')));
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
    const body = await readBody(req);
    const action = ACTIONS[body.action];
    if (!action) return json(res, 400, { error: 'unknown action' });
    const [status, payload] = await action(session, body);
    return json(res, status, payload);
  } catch (e) {
    return json(res, e.status || 500, { error: e.message || 'error' });
  }
};
