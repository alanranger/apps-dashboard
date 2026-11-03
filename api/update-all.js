/**
 * Update-all API (state only — the runner on Alan's PC executes the steps).
 *   GET  /api/update-all?run=latest|<id>     → { run, steps, registry, stages: { defs, history, plans }, page_choices }
 *   GET  /api/update-all?runs=10             → recent runs
 *   POST { action: 'start', mode: 'dry', include_audit, stages? } → request Run all (stages omitted) or a stage run
 *        (stages: ['E'] or a chain ['A','B','E']). A stage run whose prerequisites are missing, older than 7 days or
 *        stale is refused with 409 { error: 'Run A and B first', plan: { chain, chainLabel } } — never forced.
 *        Live refused until UPDATE_ALL_LIVE_ENABLED=1 and role alan.
 *   POST { action: 'resume', run_id }        → re-request a failed run from its failed step
 *   POST { action: 'cancel', run_id }
 *   POST { action: 'page_choice', url, choice: service|landing|exclude, suggested } → P16: Alan's choice for a new 06 page
 *   GET  ?page_choices=1 → every saved choice; POST { action: 'page_choice_clear_test' } → removes simulated test rows only
 * Auth: Mission Control session token (same login as the dashboard).
 */
const { json, cors, readBody, requireAuth, sb } = require('./mc/_lib');
const REGISTRY = require('../runner/steps.json');
const { STAGES, planStage, stageHistory, liveDoneHistory, sortStages } = require('../runner/stages.cjs');
const { liveState, livePlan, undoRequest } = require('./_bau-live');
const { stepEstimates, stageTypical, runnerState } = require('./_bau-progress');

const ACTIVE = 'status=in.(requested,running)';
const SITE = /^https:\/\/www\.alanranger\.com\/[a-z0-9\-/]+$/;

const recentRuns = () => sb('update_all_runs?select=id,mode,status,stages,stage_results,options,requested_at,started_at,finished_at&order=requested_at.desc&limit=60');

async function stagesInfo() {
  const runs = await recentRuns();
  const history = { dry: stageHistory(runs, 'dry'), live: stageHistory(runs, 'live'), live_done: liveDoneHistory(runs) };
  const plans = Object.fromEntries(STAGES.map((s) => [s.id, planStage([s.id], history.dry)]));
  return { defs: STAGES.map(({ id, name, steps, needs, needsAny }) => ({ id, name, steps, needs, needsAny: needsAny || null })), history, plans, typical: stageTypical(runs) };
}

async function pageChoices(run) {
  const urls = (run?.needs_alan || []).filter((n) => n.kind === 'new_08_page').map((n) => n.url);
  if (!urls.length) return [];
  return sb(`bau_page_choices?url=in.(${urls.map((u) => `"${encodeURIComponent(u)}"`).join(',')})`);
}

/** Saved decisions for this run's held reviews (so a decided review shows as saved, never asked twice). */
async function reviewChoices(run) {
  const keys = (run?.needs_alan || []).filter((n) => n.kind === 'held_review').map((n) => n.key).filter((k) => /^[\w-]+$/.test(k));
  return keys.length ? sb(`bau_review_choices?review_key=in.(${keys.join(',')})`) : [];
}

async function latestRun(id, session) {
  const q = id && id !== 'latest' ? `update_all_runs?id=eq.${encodeURIComponent(id)}` : 'update_all_runs?order=requested_at.desc&limit=1';
  const run = (await sb(q))[0] || null;
  const steps = run ? await sb(`update_all_steps?run_id=eq.${run.id}&order=ord.asc`) : [];
  const [stages, estimates, runner] = await Promise.all([stagesInfo(), stepEstimates(run), runnerState()]);
  return { run, steps, registry: REGISTRY, stages, live: liveState(session, stages.history), page_choices: await pageChoices(run), review_choices: await reviewChoices(run),
    estimates, runner, server_now: new Date().toISOString() };
}

const historyNow = async () => { const runs = await recentRuns(); return { dry: stageHistory(runs, 'dry'), live: stageHistory(runs, 'live'), live_done: liveDoneHistory(runs) }; };

/** Valid stage letters in order, or null for Run all. */
function cleanStages(stages) {
  if (!Array.isArray(stages) || !stages.length) return null;
  const ids = new Set(STAGES.map((s) => s.id));
  const picked = sortStages(stages.filter((s) => ids.has(s)));
  return picked.length ? picked : null;
}

/** Test aid (dry only): pretend these pages are new in 06 so the 08 buttons can be exercised. */
const simulated = (mode, urls) => (mode === 'dry' && Array.isArray(urls) ? urls.filter((u) => SITE.test(u)).slice(0, 5) : []);

/** Live promotes the stage's latest dry run (the runner re-checks this, and that the files are unchanged). */
function liveRefusal(stage, dry) {
  // Stage I promotes nothing: live I starts the full audit ① now (the runner also refuses while ① is running).
  if (stage === 'I') return new Date().getUTCDay() === 1 ? 'Never on a Monday: the Monday cron runs ①' : null;
  if (!dry) return `Run stage ${stage} dry first`;
  if (!['ok', 'warn'].includes(dry.status)) return `Stage ${stage}'s last dry run ${dry.status} — run it dry again`;
  if (Date.now() - Date.parse(dry.finished_at) > 7 * 24 * 3600 * 1000) return `Stage ${stage}'s last dry run is older than 7 days — run it dry again`;
  // B writes only the database (its safety is the automatic backup), so it has no file list to check.
  if (dry.removals_unexplained == null && stage !== 'B') return `Stage ${stage}'s last dry run predates the removal check — run it dry again`;
  if (dry.removals_unexplained) return `Stage ${stage}'s dry run has ${dry.removals_unexplained} unexplained removals — Live is blocked until they are fixed or explained`;
  return null;
}

/** Live: switched on, Alan only, one stage per run — Run all live only once every stage A–I has run live once. */
async function liveGate(session, body, mode) {
  if (mode !== 'live') return null;
  if (process.env.UPDATE_ALL_LIVE_ENABLED !== '1' || session.role !== 'alan') return [403, { error: 'LIVE mode is not enabled yet' }];
  const runAll = !Array.isArray(body.stages) || !body.stages.length;
  if (runAll && !liveState(session, await historyNow()).run_all_unlocked) return [400, { error: 'Live Run all unlocks after stages A–H have each run live once' }];
  if (!runAll && body.stages.length !== 1) return [400, { error: "Live runs one stage at a time — use that stage's Run this stage button" }];
  return null;
}

/** Dry stage runs check their prerequisites; a live stage checks the dry run it would promote. */
async function stageRefusal(stages, mode) {
  const history = stageHistory(await recentRuns(), 'dry');
  if (mode === 'live') {
    const why = liveRefusal(stages[0], history[stages[0]]);
    return why ? [409, { error: why }] : null;
  }
  const plan = planStage(stages, history);
  return plan.ok ? null : [409, { error: plan.message, plan }];
}

async function start(session, body) {
  const mode = body.mode === 'live' ? 'live' : 'dry';
  const gate = await liveGate(session, body, mode);
  if (gate) return gate;
  const active = await sb(`update_all_runs?${ACTIVE}&limit=1`);
  if (active.length) return [409, { error: 'a run is already requested or running', run: active[0] }];
  const stages = cleanStages(body.stages);
  const refused = stages ? await stageRefusal(stages, mode) : null;
  if (refused) return refused;
  const sim = simulated(mode, body.simulate_new_08);
  const held = mode === 'dry' ? Math.min(4, Math.max(0, Number(body.simulate_held_reviews) || 0)) : 0;
  // "Force full re-read" (live B only): every imported page is re-ingested, not just the changed ones.
  const force = mode === 'live' && stages?.length === 1 && stages[0] === 'B' && body.force_full_reread === true;
  const options = { ...(sim.length ? { simulate_new_08: sim } : {}), ...(held ? { simulate_held_reviews: held } : {}), ...(force ? { force_full_reread: true } : {}) };
  const run = (await sb('update_all_runs', { method: 'POST',
    body: { mode, status: 'requested', requested_by: session.role, include_audit: stages ? stages.includes('I') : body.include_audit !== false, stages, options } }))[0];
  return [200, { run }];
}

/** Resume re-runs from the failed step; a live run passes the same live gate as starting one. */
async function resume(session, body) {
  const [target] = await sb(`update_all_runs?id=eq.${encodeURIComponent(body.run_id)}&select=mode,stages`);
  if (!target) return [404, { error: 'run not found' }];
  const gate = await liveGate(session, { stages: target.stages }, target.mode);
  if (gate) return gate;
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

/** P16: save Alan's choice for a page new in 06 (Exclude included), so it is never asked about twice. */
async function pageChoice(session, body) {
  if (!SITE.test(String(body.url || '')) || !['service', 'landing', 'exclude'].includes(body.choice)) return [400, { error: 'url and choice (service, landing, exclude) required' }];
  const row = { url: body.url, choice: body.choice, suggested: ['service', 'landing'].includes(body.suggested) ? body.suggested : null,
    decided_by: session.role, decided_at: new Date().toISOString() };
  const saved = await sb('bau_page_choices?on_conflict=url', { method: 'POST', body: row, prefer: 'resolution=merge-duplicates,return=representation' });
  return [200, { choice: saved[0] }];
}

/** Test clean-up: removes only choices saved for simulated pages (/bau-test-simulated-…). */
async function clearTestChoices() {
  const gone = await sb('bau_page_choices?url=like.*bau-test-simulated-*', { method: 'DELETE' });
  return [200, { removed: (gone || []).length }];
}

const REVIEW_CHOICES = ['product', 'business_level', 'exclude'];
/** Batch 8: Alan's decision on a held review (key = opaque hash from the run; no name is sent). */
async function reviewChoice(session, body) {
  const key = String(body.review_key || '');
  if (!/^[\w-]{6,40}$/.test(key) || !REVIEW_CHOICES.includes(body.choice)) return [400, { error: 'review_key and choice (product, business_level, exclude) required' }];
  if (body.choice === 'product' && !/^[a-z0-9-]+$/.test(String(body.product_slug || ''))) return [400, { error: 'product_slug required' }];
  if (body.choice === 'exclude' && !String(body.reason || '').trim()) return [400, { error: 'a reason is required to exclude' }];
  const row = { review_key: key, choice: body.choice, product_slug: body.choice === 'product' ? body.product_slug : null,
    reason: body.choice === 'exclude' ? String(body.reason).trim().slice(0, 200) : null, suggested: body.suggested || null,
    decided_by: session.role, decided_at: new Date().toISOString() };
  const saved = await sb('bau_review_choices?on_conflict=review_key', { method: 'POST', body: row, prefer: 'resolution=merge-duplicates,return=representation' });
  return [200, { choice: saved[0] }];
}

/** Test clean-up: removes only choices saved for simulated held reviews (bau-test-…). */
async function clearTestReviewChoices() {
  const gone = await sb('bau_review_choices?review_key=like.bau-test-*', { method: 'DELETE' });
  return [200, { removed: (gone || []).length }];
}

/** "Undo this stage" (live): reverse the stage's latest live publish; the runner re-checks it before acting. */
async function undo(session, body) {
  const active = (await sb(`update_all_runs?${ACTIVE}&limit=1`))[0] || null;
  return undoRequest(session, body, await historyNow(), active);
}

const ACTIONS = { start, resume, cancel: (s, b) => cancel(b), page_choice: pageChoice, page_choice_clear_test: () => clearTestChoices(),
  review_choice: reviewChoice, review_choice_clear_test: () => clearTestReviewChoices(), undo };

module.exports = async function handler(req, res) {
  if (cors(req, res)) return;
  const session = requireAuth(req, res);
  if (!session) return;
  try {
    if (req.method === 'GET') {
      const url = new URL(req.url, 'http://x');
      if (url.searchParams.get('runs')) return json(res, 200, { runs: await sb(`update_all_runs?order=requested_at.desc&limit=${Math.min(50, Number(url.searchParams.get('runs')) || 10)}`) });
      if (url.searchParams.get('page_choices')) return json(res, 200, { choices: await sb('bau_page_choices?order=url.asc') });
      if (url.searchParams.get('review_choices')) return json(res, 200, { choices: await sb('bau_review_choices?order=review_key.asc') });
      const plan = url.searchParams.get('live_plan');
      if (plan) return json(res, 200, await livePlan(plan, await historyNow(), liveRefusal));
      return json(res, 200, await latestRun(url.searchParams.get('run'), session));
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
