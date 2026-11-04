// A check run (1. Build & check) writes only into its sandbox (Claude/Alan 4 Nov, H refused by left-over files).
// For each stage: snapshot alan-shared-resources and alanranger-schema (HEAD, `git status --porcelain`, a hash of every
// pending file), click 1. Build & check on the page, wait for the dry run to finish, snapshot again: both must be identical,
// and nothing under bookings/ is staged. The guard lets only that dry start through (allowDryCheck); nothing goes live.
// Run: MC_AGENT_PASSWORD=… MC_BASE_URL=https://apps-dashboard-lilac.vercel.app BAU_CHECK_STAGES=F,A,B npx playwright test tests/e2e/bau-check-leaves-repos-clean.spec.js
import { test, expect } from '../helpers/bau-guard.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mcBaseUrl, mcLogin, mcApi } from '../helpers/mc.mjs';

const WEB = 'G:/Dropbox/alan ranger photography/Website Code';
const REPOS = { shared: `${WEB}/alan-shared-resources`, schema: `${WEB}/Schema Tools/alanranger-schema` };
const STAGES = String(process.env.BAU_CHECK_STAGES || 'F').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const EVIDENCE = process.env.EVIDENCE_DIR || path.join(process.cwd(), 'tmp', 'bau-check-leaves-repos-clean');
const FINISHED = ['succeeded', 'warned', 'failed', 'cancelled'];
let session;

const git = (repo, args) => spawnSync('git', ['-c', 'core.quotePath=false', ...args], { cwd: repo, encoding: 'utf8' }).stdout || '';
const hashOf = (p) => {
  try { return fs.statSync(p).isFile() ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : 'dir'; } catch { return 'missing'; }
};

/** HEAD + porcelain + content hash of each pending file: a check that rewrote an already-modified file still shows. */
function snapshot(repo) {
  const status = git(repo, ['status', '--porcelain=v1', '-uall']).split(/\r?\n/).filter(Boolean);
  const files = status.map((l) => l.slice(3).replace(/^"|"$/g, ''));
  return { head: git(repo, ['rev-parse', 'HEAD']).trim(), status, hashes: Object.fromEntries(files.map((f) => [f, hashOf(path.join(repo, f))])) };
}
const snapshotAll = () => Object.fromEntries(Object.entries(REPOS).map(([k, r]) => [k, snapshot(r)]));

test.use({ channel: 'chrome', allowDryCheck: true });
test.describe.configure({ mode: 'serial', timeout: 2 * 60 * 60 * 1000 });
test.beforeAll(async () => { session = await mcLogin('agent'); fs.mkdirSync(EVIDENCE, { recursive: true }); });

const latest = async () => (await mcApi('/api/update-all?run=latest', { token: session.token })).run || null;

async function openPage(page) {
  await page.addInitScript((s) => { sessionStorage.setItem('mc_session_token', s.token); sessionStorage.setItem('mc_session_role', s.role); }, session);
  await page.goto(`${mcBaseUrl()}/bau-workflow.html`);
  await expect(page.getByTestId('stage-run-A')).toBeVisible({ timeout: 30000 });
}

for (const stage of STAGES) {
  test(`1. Build & check on stage ${stage} leaves both repos exactly as they were`, async ({ page }) => {
    const before = snapshotAll();
    const prev = (await latest())?.id || null;
    await openPage(page);
    await page.getByTestId(`stage-run-${stage}`).click();
    await expect.poll(async () => (await latest())?.id, { timeout: 60000 }).not.toBe(prev);
    const run = await latest();
    expect(run.mode).toBe('dry');
    expect(run.stages).toEqual([stage]);
    await expect.poll(async () => FINISHED.includes((await latest())?.status), { timeout: 110 * 60 * 1000, intervals: [30000] }).toBe(true);
    const done = await latest();
    const after = snapshotAll();
    fs.writeFileSync(path.join(EVIDENCE, `stage-${stage}.json`), JSON.stringify({ run: { id: done.id, status: done.status, mode: done.mode, stages: done.stages }, before, after }, null, 2));
    await page.reload();
    await page.screenshot({ path: path.join(EVIDENCE, `stage-${stage}-finished.png`), fullPage: true });
    expect(after.shared, 'alan-shared-resources changed during the check run').toEqual(before.shared);
    expect(after.schema, 'alanranger-schema changed during the check run').toEqual(before.schema);
    const staged = git(REPOS.shared, ['diff', '--cached', '--name-only']).split(/\r?\n/).filter(Boolean);
    expect(staged.filter((f) => f.startsWith('bookings/')), 'nothing under bookings/ may be staged').toEqual([]);
  });
}
