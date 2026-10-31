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
import { executeRun } from './engine.mjs';
import { acquireLock, logger, releaseLock } from './lock-log.mjs';
import { loadEnv, supabaseStore } from './store.mjs';
import { HANDLERS, SHARED } from './steps.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REGISTRY = JSON.parse(fs.readFileSync(path.join(HERE, 'steps.json'), 'utf8'));
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

async function process1(store, run) {
  if (run.mode !== 'dry' && process.env.UPDATE_ALL_LIVE_ENABLED !== '1') {
    await store.updateRun(run.id, { status: 'cancelled', error: 'LIVE mode is not enabled yet', finished_at: new Date().toISOString() });
    return 'cancelled';
  }
  const storedFail = run.resume_from ? null : run.options?.fail_step;
  const ctx = { mode: run.mode, store, host: os.hostname(), failStep: arg('--fail-step') || storedFail || null, sandboxBase: arg('--sandbox'),
    siteRetries: process.env.UPDATE_ALL_SITE_RETRIES ? Number(process.env.UPDATE_ALL_SITE_RETRIES) : undefined };
  say(`[update-all] run ${run.id} (${run.mode}) starting${run.resume_from ? ` — resume from ${run.resume_from}` : ''}`);
  holdAutoSyncLock(run.id);
  let status;
  try {
    status = await executeRun(store, run, REGISTRY, selectedHandlers(arg('--only')), ctx);
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
  if (has('--start')) return process1(store, await store.createRun({ mode: 'dry', status: 'running', requested_by: 'runner-cli', options: { fail_step: arg('--fail-step') } }));
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
