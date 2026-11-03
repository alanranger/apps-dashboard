#!/usr/bin/env node
/**
 * Update-all runner (Alan's PC). State lives in Supabase update_all_runs / update_all_steps, so the page
 * (apps-dashboard bau-workflow.html, any device) shows progress and can request a run or a resume.
 *
 *   node runner/update-all-runner.mjs --start            create + run a DRY run now
 *   node runner/update-all-runner.mjs --once             run the oldest run requested from the page, then exit
 *   node runner/update-all-runner.mjs --watch            keep polling for requested runs (every 15 s)
 *   node runner/update-all-runner.mjs --resume <run-id>  resume a failed run from its failed step
 *   --fail-step <step-id>   test only: force that step to fail
 *   --only <id,id>          test only: run just these steps (the rest are recorded as skipped)
 *   UPDATE_ALL_SITE_RETRIES test only: fewer 429 retries in the pre-flight site check
 *
 * LIVE mode is refused until Alan enables it (UPDATE_ALL_LIVE_ENABLED=1 and live handlers wired).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { executeRun } from './engine.mjs';
import { acquireLock, logger, releaseLock } from './lock-log.mjs';
import { loadEnv, supabaseStore } from './store.mjs';
import { HANDLERS, SHARED, readSiteState, retryAfterMs, sandboxFor, seedSandbox, siteProbe } from './steps.mjs';
import { cooldownUntil, parkDecision, probeFor, rateLimitedNeed, waitingText } from './cooldown.mjs';
import { LIVE_STAGES } from './publish-live.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REGISTRY = JSON.parse(fs.readFileSync(path.join(HERE, 'steps.json'), 'utf8'));
const { planStage, seedSources, stageHistory, stepsFor } = createRequire(import.meta.url)('./stages.cjs');

/** Run all = every step; a stage run = pre-flight + its stages' steps + summary. */
export const registryFor = (stages) => { const ids = stepsFor(stages); return ids ? REGISTRY.filter((d) => ids.includes(d.id)) : REGISTRY; };

/**
 * A stage run checks its prerequisites (never forced) and seeds its sandbox from their saved outputs.
 * Returns null when the run can go ahead, or the reason it can't (the page then offers the chain).
 */
export async function prepareStageRun(store, run, ctx) {
  if (!run.stages?.length || run.mode !== 'dry') return null;
  const runs = await store.query(`update_all_runs?select=id,stage_results,finished_at&id=neq.${run.id}&order=requested_at.desc&limit=60`);
  const history = stageHistory(runs, run.mode);
  const plan = planStage(run.stages, history);
  if (!plan.ok) return `${plan.message} (${Object.entries(plan.reasons).map(([s, r]) => `${s}: ${r}`).join('; ')}) — ${plan.chainLabel}`;
  const seeded = seedSandbox(ctx, seedSources(run.stages, history));
  return seeded.missing ? `saved inputs are gone from this PC: ${seeded.missing} — run that stage again` : null;
}
/** Why a stage's latest dry run can't be promoted to Live, or null. */
export function liveReadiness(stage, dry, now = Date.now()) {
  if (!dry) return `stage ${stage} has never been dry-run`;
  if (!['ok', 'warn'].includes(dry.status)) return `stage ${stage}'s last dry run ${dry.status}`;
  if (now - Date.parse(dry.finished_at) > 7 * 24 * 3600 * 1000) return `stage ${stage}'s last dry run is older than 7 days`;
  if (dry.removals_unexplained == null) return `stage ${stage}'s last dry run predates the removal check`;
  if (dry.removals_unexplained) return `stage ${stage}'s dry run has ${dry.removals_unexplained} unexplained removals`;
  if (!dry.sandbox || !fs.existsSync(dry.sandbox)) return `stage ${stage}'s dry run outputs are gone from this PC`;
  return null;
}

/**
 * LIVE: one stage per run, a stage whose live path is built, and a usable dry run to promote.
 * Returns { promote } (the dry run whose files are published) or { blocked } (why not, with what to run first).
 */
export async function prepareLiveRun(store, run) {
  if (run.mode !== 'live') return {};
  if (run.stages?.length !== 1) return { blocked: "Live runs one stage at a time (use that stage's Run this stage button)" };
  const stage = run.stages[0];
  if (!LIVE_STAGES.has(stage)) return { blocked: `Live is not built for stage ${stage} yet` };
  const runs = await store.query(`update_all_runs?select=id,stage_results,finished_at&id=neq.${run.id}&order=requested_at.desc&limit=60`);
  const dry = stageHistory(runs, 'dry')[stage];
  const why = liveReadiness(stage, dry);
  if (why) return { blocked: `${why} — run stage ${stage} dry, then Live` };
  return { promote: { stage, run_id: dry.run_id, sandbox: dry.sandbox, finished_at: dry.finished_at, published: dry.published || [], removed: dry.removed || [] } };
}

const arg = (flag) => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : null; };
const has = (flag) => process.argv.includes(flag);

function openStore() {
  const env = loadEnv(path.join(HERE, '..', '.env.local'));
  if (!env.MC_SUPABASE_URL || !env.MC_SUPABASE_SERVICE_KEY) throw new Error('MC_SUPABASE_URL / MC_SUPABASE_SERVICE_KEY missing in apps-dashboard/.env.local');
  return supabaseStore({ url: env.MC_SUPABASE_URL, key: env.MC_SUPABASE_SERVICE_KEY });
}

/** csv/.update-all.lock pauses shared-resources auto-push while a run is in progress (stale after 6 h). */
export const AUTO_SYNC_LOCK = path.join(SHARED, 'csv', '.update-all.lock');
function holdAutoSyncLock(runId) {
  fs.writeFileSync(AUTO_SYNC_LOCK, JSON.stringify({ runId, at: new Date().toISOString(), host: os.hostname() }));
}
function releaseAutoSyncLock(runId) {
  try {
    if (JSON.parse(fs.readFileSync(AUTO_SYNC_LOCK, 'utf8')).runId === runId) fs.unlinkSync(AUTO_SYNC_LOCK);
  } catch { /* already gone */ }
}

/** --only a,b,c (tests): steps not listed are recorded as skipped. */
function selectedHandlers(only) {
  if (!only) return HANDLERS;
  const keep = new Set(only.split(','));
  return Object.fromEntries(Object.entries(HANDLERS).map(([id, h]) => [id, keep.has(id) ? h : async () => ({ status: 'skipped', warnings: ['not selected for this test run (--only)'] })]));
}

/**
 * LIVE only: one lightweight pre-flight probe; a 429 (or one recorded in the last 30 min) parks the run until the
 * cool-down ends. After a park the probe changes URL; a third park in a row stops the run and asks Alan.
 */
async function liveCooldown(store, run) {
  const parks = Number(run.options?.cooldown_parks || 0);
  const res = await siteProbe(probeFor(parks)).catch(() => null);
  const status = res?.status || 0;
  const until = cooldownUntil({ mode: run.mode, last429At: readSiteState().last429At, status, retryAfterMs: res ? retryAfterMs(res.headers) : 0 });
  const decision = parkDecision({ status, until, parks });
  if (decision === 'go') {
    if (run.cooldown_until || parks) await store.updateRun(run.id, { cooldown_until: null, options: { ...(run.options || {}), cooldown_parks: 0 } });
    return false;
  }
  if (decision === 'needs_alan') {
    await store.updateRun(run.id, { status: 'failed', cooldown_until: null, finished_at: new Date().toISOString(),
      error: rateLimitedNeed(parks).file, needs_alan: [...(run.needs_alan || []), rateLimitedNeed(parks)] });
    say(`[update-all] run ${run.id} (live): rate-limited ${parks + 1} times in a row — stopped, listed under Needs Alan`);
    return true;
  }
  const options = decision === 'park' ? { ...(run.options || {}), cooldown_parks: parks + 1 } : run.options;
  await store.updateRun(run.id, { status: 'requested', cooldown_until: until, options });
  say(`[update-all] run ${run.id} (live): ${waitingText(until)} — it starts automatically after that`);
  return true;
}

/** Step context for one run: stage runs include ① only when stage I is chosen; Run all follows the tick-box. */
/** Test aids carried by a run (dry only): injected failure, simulated new 08 pages / held reviews, fewer retries. */
function testOptions(run) {
  const dry = run.mode === 'dry';
  return { failStep: arg('--fail-step') || (run.resume_from ? null : run.options?.fail_step) || null,
    simulateNew08: dry ? (run.options?.simulate_new_08 || []) : [],
    simulateHeld: dry ? Number(run.options?.simulate_held_reviews || 0) : 0,
    siteRetries: process.env.UPDATE_ALL_SITE_RETRIES ? Number(process.env.UPDATE_ALL_SITE_RETRIES) : undefined };
}

function runContext(store, run, promote) {
  const stages = run.stages?.length ? run.stages : null;
  const includeAudit = stages ? stages.includes('I') : (run.include_audit !== false && !has('--no-audit'));
  const ctx = { mode: run.mode, store, host: os.hostname(), sandboxBase: arg('--sandbox'), includeAudit, stages, ...testOptions(run), promote: promote || null };
  ctx.sandboxRoot = sandboxFor({ ...ctx, runId: run.id }).root;
  return ctx;
}

async function process1(store, run) {
  if (run.mode !== 'dry' && process.env.UPDATE_ALL_LIVE_ENABLED !== '1') {
    await store.updateRun(run.id, { status: 'cancelled', error: 'LIVE mode is not enabled yet', finished_at: new Date().toISOString() });
    return 'cancelled';
  }
  const live = await prepareLiveRun(store, run);
  if (live.blocked) {
    await store.updateRun(run.id, { status: 'failed', error: live.blocked, finished_at: new Date().toISOString() });
    say(`[update-all] run ${run.id} (live) not started: ${live.blocked}`);
    return 'failed';
  }
  if (run.mode === 'live' && await liveCooldown(store, run)) return 'waiting';
  const ctx = runContext(store, run, live.promote || null);
  say(`[update-all] run ${run.id} (${run.mode}, ${ctx.stages ? `stages ${ctx.stages.join('')}` : 'run all'}) starting${run.resume_from ? ` — resume from ${run.resume_from}` : ''}`);
  const blocked = run.resume_from ? null : await prepareStageRun(store, run, { ...ctx, runId: run.id }).catch((e) => `could not prepare the stage inputs: ${String(e?.message || e).slice(0, 300)}`);
  if (blocked) {
    await store.updateRun(run.id, { status: 'failed', error: blocked, finished_at: new Date().toISOString() });
    say(`[update-all] run ${run.id} not started: ${blocked}`);
    return 'failed';
  }
  holdAutoSyncLock(run.id);
  let status;
  try {
    status = await executeRun(store, run, registryFor(ctx.stages), selectedHandlers(arg('--only')), ctx);
  } finally {
    releaseAutoSyncLock(run.id);
  }
  for (const s of await store.listSteps(run.id)) say(`  ${String(s.ord).padStart(2)} ${s.status.padEnd(8)} ${s.name}${s.error ? ` — ${s.error}` : ''}`);
  say(`[update-all] run ${run.id} finished: ${status}`);
  return status;
}

const fileLog = logger();
function say(msg) {
  console.log(msg);
  fileLog(msg);
}

async function main() {
  if (!acquireLock()) {
    say('[update-all] another runner holds the lock — exiting');
    return null;
  }
  try {
    return await dispatch(openStore());
  } finally {
    releaseLock();
  }
}

async function dispatch(store) {
  if (has('--start')) {
    const stages = arg('--stages') ? arg('--stages').split(',') : null;
    return process1(store, await store.createRun({ mode: 'dry', status: 'running', requested_by: 'runner-cli', stages, options: { fail_step: arg('--fail-step') } }));
  }
  if (arg('--resume')) {
    const run = await store.getRun(arg('--resume'));
    if (!run) throw new Error('run not found');
    return process1(store, run);
  }
  do {
    const next = await store.nextRequested();
    if (next) await process1(store, next);
    else if (has('--once')) fileLog('[update-all] no requested run');
    if (has('--watch')) await new Promise((r) => setTimeout(r, 15000));
  } while (has('--watch'));
  return null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
