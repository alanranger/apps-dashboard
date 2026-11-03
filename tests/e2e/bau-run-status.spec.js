// BAU Monthly status box (Claude/Alan 3 Nov, live session): queued → running → finished / failed, the LIVE badge,
// "Run all mode" beside Run all, and the stage history row with files + commit. Read-only: only the page's GET of
// the latest run is replaced by a simulated run (route), nothing is posted and no stage runs.
// Run: MC_AGENT_PASSWORD=… MC_BASE_URL=https://apps-dashboard-lilac.vercel.app EVIDENCE_DIR=… npx playwright test tests/e2e/bau-run-status.spec.js
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { mcBaseUrl, mcLogin, mcApi } from '../helpers/mc.mjs';

const EVIDENCE = process.env.EVIDENCE_DIR || path.join(process.cwd(), 'tmp', 'bau-run-status');
const FILES = ['csv/04-reviews.csv', 'csv/04b-review-products.csv', 'csv/raw-04-google-reviews.csv'];
const STEPS = [{ ord: 1, step_id: 'preflight', name: 'Pre-flight', status: 'ok' }, { ord: 4, step_id: 'reviews', name: 'Reviews (04)', status: 'running' },
  { ord: 18, step_id: 'summary', name: 'Summary', status: 'pending' }];
let session;

test.use({ channel: 'chrome' });
test.beforeAll(async () => { session = await mcLogin('agent'); fs.mkdirSync(EVIDENCE, { recursive: true }); });

const ago = (s) => new Date(Date.now() - s * 1000).toISOString();
const base = () => ({ id: 'simulated-0000-0000', mode: 'live', stages: ['C'], options: {}, requested_at: ago(20), include_audit: false, needs_alan: [], stage_results: {} });
const STATES = {
  queued: () => ({ run: { ...base(), status: 'requested' }, steps: [] }),
  running: () => ({ run: { ...base(), status: 'running', started_at: ago(12), current_step: 'reviews' }, steps: STEPS }),
  finished: () => ({ run: { ...base(), status: 'succeeded', started_at: ago(12), finished_at: ago(2),
    stage_results: { C: { status: 'ok', mode: 'live', published: FILES, publish_mode: 'published', commit: 'deadbeefcafe', repo: 'alan-shared-resources' } } },
  steps: STEPS.map((s) => ({ ...s, status: 'ok' })) }),
  failed: () => ({ run: { ...base(), status: 'failed', started_at: ago(12), finished_at: ago(2), error: 'Reviews (04): the shared repo has uncommitted changes to csv/04-reviews.csv' },
    steps: [STEPS[0], { ...STEPS[1], status: 'fail', error: 'uncommitted changes', notes: [{ level: 'problem', text: 'uncommitted changes', todo: 'commit or revert csv/04-reviews.csv, then Resume' }] }] }),
};

/** Replace only the latest-run GET; real stage history, registry and live state pass through. */
const latestGet = (url) => url.pathname === '/api/update-all' && url.searchParams.has('run');
async function simulate(page, state) {
  await page.unroute(latestGet).catch(() => {});
  await page.route(latestGet, async (route) => {
    const real = await (await route.fetch()).json();
    await route.fulfill({ json: { ...real, ...STATES[state]() } });
  });
}

async function openPage(page) {
  await page.addInitScript((s) => { sessionStorage.setItem('mc_session_token', s.token); sessionStorage.setItem('mc_session_role', s.role); localStorage.removeItem('bau_dismissed_run'); }, session);
  await page.goto(`${mcBaseUrl()}/bau-workflow.html`);
  await expect(page.getByTestId('stage-run-A')).toBeVisible({ timeout: 30000 });
}
const shot = (page, name) => page.screenshot({ path: path.join(EVIDENCE, `${name}.png`), fullPage: false });

test('status box: queued → running → finished → failed, with the LIVE badge', async ({ page }) => {
  await simulate(page, 'queued');
  await openPage(page);
  await expect(page.getByTestId('run-status-queued')).toContainText('Queued — stage C');
  await expect(page.getByTestId('run-status')).toContainText('within ~1 minute');
  await expect(page.getByTestId('run-mode').getByTestId('mode-live')).toHaveText('LIVE');
  await shot(page, '1-queued');

  await simulate(page, 'running');
  await expect(page.getByTestId('run-status-running')).toContainText('Running stage C — step 2 of 3: Reviews (04)', { timeout: 15000 });
  await expect(page.getByTestId('run-status')).toContainText('Elapsed');
  await shot(page, '2-running');

  await simulate(page, 'finished');
  const done = page.getByTestId('run-status-finished');
  await expect(done).toContainText('Published live — stage C', { timeout: 15000 });
  await expect(page.getByTestId('run-status-files')).toContainText('published 3 files');
  await expect(page.getByTestId('run-status').getByTestId('commit-link')).toHaveAttribute('href', /alan-shared-resources\/commit\/deadbeefcafe/);
  await expect(page.getByTestId('action-msg')).toContainText('Last run finished');
  await expect(page.getByTestId('action-msg')).not.toContainText('Running');
  await shot(page, '3-finished');
  await page.getByTestId('run-status-dismiss').click();
  await expect(page.getByTestId('run-status')).toBeHidden();

  await page.evaluate(() => localStorage.removeItem('bau_dismissed_run'));
  await simulate(page, 'failed');
  await expect(page.getByTestId('run-status-finished')).toContainText('Live publish failed', { timeout: 15000 });
  await expect(page.getByTestId('run-status-error')).toContainText('uncommitted changes');
  await expect(page.getByTestId('run-status')).toContainText('commit or revert csv/04-reviews.csv, then Resume');
  await shot(page, '4-failed');
});

test('top panel: "Run all mode" beside Run all; stage A live row shows files + commit (real history, unchanged)', async ({ page }) => {
  await openPage(page);
  await expect(page.locator('.run-all-mode')).toContainText('Run all mode:');
  await expect(page.getByTestId('run-all-live-note')).toContainText('Run all: test run only');
  await expect(page.getByText('checks every minute')).toBeVisible();
  const plan = await mcApi('/api/update-all?live_plan=A', { token: session.token });
  expect(plan.last_live?.undo?.commit?.startsWith('3ccf6a6')).toBe(true);
  const row = page.locator('tr[data-stage="A"]').getByTestId('stage-history-live');
  await expect(row).toContainText('LIVE');
  await expect(row).toContainText('published 3 files');
  await expect(row.getByTestId('commit-link')).toHaveText('3ccf6a6');
  await expect(row.getByTestId('commit-link')).toHaveAttribute('href', /alan-shared-resources\/commit\/3ccf6a6/);
  await page.locator('tr[data-stage="A"]').scrollIntoViewIfNeeded();
  await shot(page, '5-stage-a-history-row');
});
