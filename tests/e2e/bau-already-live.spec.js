// BAU "Already live" (Alan 4 Nov): a stage whose newest ok test run has already been published shows a grey, disabled
// "Already live — run a new test first" (tooltip: run, date, commit); a newer test run brings back "Publish live…";
// a refused re-promote says "This test run is already live …" instead of "run dry again, then Live".
// Read-only: the real page; the newer test run and the refused run are simulated (route). Nothing is posted.
// Run: MC_AGENT_PASSWORD=… MC_BASE_URL=https://apps-dashboard-lilac.vercel.app EVIDENCE_DIR=… npx playwright test tests/e2e/bau-already-live.spec.js
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { mcBaseUrl, mcLogin } from '../helpers/mc.mjs';

const EVIDENCE = process.env.EVIDENCE_DIR || path.join(process.cwd(), 'tmp', 'bau-already-live');
let session;
test.use({ channel: 'chrome', viewport: { width: 1280, height: 1400 } });
test.beforeAll(async () => { session = await mcLogin('agent'); fs.mkdirSync(EVIDENCE, { recursive: true }); });

const latestGet = (u) => u.pathname === '/api/update-all' && u.searchParams.has('run');
async function openPage(page) {
  await page.addInitScript((s) => { sessionStorage.setItem('mc_session_token', s.token); sessionStorage.setItem('mc_session_role', s.role); localStorage.removeItem('bau_dismissed_run'); }, session);
  await page.goto(`${mcBaseUrl()}/bau-workflow.html`);
  await expect(page.getByTestId('stage-run-A')).toBeVisible({ timeout: 30000 });
}
const isAlreadyLive = async (page, id) => (await page.getByTestId(`stage-live-${id}`).getAttribute('data-already-live')) === '1';

test('real page: stages whose newest test run is live show "Already live"; those with a newer test run show Publish live', async ({ page }) => {
  await openPage(page);
  const data = await (await page.request.get(`${mcBaseUrl()}/api/update-all?run=latest`, { headers: { 'x-mc-token': session.token } })).json();
  const h = data.stages.history;
  for (const id of 'ABCDEFGH') {
    const expected = !!(h.dry[id] && h.live_done?.[id] && !h.live_done[id].undo_of && h.live_done[id].promoted_from === h.dry[id].run_id);
    const btn = page.getByTestId(`stage-live-${id}`);
    expect(await isAlreadyLive(page, id), `stage ${id}`).toBe(expected);
    if (expected) {
      await expect(btn).toBeDisabled();
      await expect(btn).toHaveText('2. Already live');
      await expect(btn).toHaveAttribute('title', new RegExp(`Checked build ${h.dry[id].run_id.slice(0, 8)} was published live on`));
    } else {
      await expect(btn).toHaveText('2. Publish live…');
    }
  }
  await expect(page.getByTestId('stage-live-I')).toHaveText('Start full audit ①…');
  await page.locator('[data-testid="stages-table"]').screenshot({ path: path.join(EVIDENCE, 'stages-table.png') });
});

test('a newer ok test run for D brings back its orange Publish live; the others stay Already live', async ({ page }) => {
  await page.route(latestGet, async (route) => {
    const real = await (await route.fetch()).json();
    real.stages.history.dry.D = { ...real.stages.history.dry.D, run_id: 'simulated-newer-dry-d', finished_at: new Date().toISOString(), status: 'ok' };
    await route.fulfill({ json: real });
  });
  await openPage(page);
  expect(await isAlreadyLive(page, 'D')).toBe(false);
  await expect(page.getByTestId('stage-live-D')).toHaveText('2. Publish live…');
  for (const id of 'EFGH') expect(await isAlreadyLive(page, id), id).toBe(true);
});

test('a refused re-promote of an already-live test run says so (not "run dry again, then Live")', async ({ page }) => {
  await page.route(latestGet, async (route) => {
    const real = await (await route.fetch()).json();
    const d = real.stages.history.live_done.D;
    real.run = { id: 'simulated-refused-d', mode: 'live', status: 'failed', stages: ['D'], options: {}, requested_at: new Date(Date.now() - 60000).toISOString(),
      started_at: new Date(Date.now() - 50000).toISOString(), finished_at: new Date().toISOString(), include_audit: false, needs_alan: [],
      error: `Publish product schema files: The schema repo changed since dry run ${String(d.promoted_from).slice(0, 8)}: the publish list is different now`,
      stage_results: { D: { status: 'fail', mode: 'live', promoted_from: d.promoted_from, published: [] } } };
    real.steps = [{ ord: 1, step_id: 'preflight', name: 'Pre-flight checks', status: 'ok' },
      { ord: 6, step_id: 'publish_products', name: 'Publish product schema files', status: 'fail', error: real.run.error,
        notes: [{ level: 'problem', text: 'The schema repo changed since dry run', todo: 'run stage D dry again, then Live' }] }];
    await route.fulfill({ json: real });
  });
  await openPage(page);
  await expect(page.locator('#runStatus')).toContainText('This checked build is already live (published');
  await expect(page.locator('#runStatus')).toContainText('Build & check again to publish this stage again.');
  await expect(page.locator('#runStatus')).not.toContainText('run stage D dry again, then Live');
  await page.locator('#runStatus').screenshot({ path: path.join(EVIDENCE, 'refused-already-live.png') });
});
