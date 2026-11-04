// BAU Monthly Live on the page (Claude/Alan 3 Nov, step 6), as the TEST account (agent). Nothing is ever published:
// the agent account signs in as role alan, so the page's POSTs are blocked here and only Cancel is ever clicked.
//  1) Live is only on the per-stage buttons; Run all stays dry (its Live option is disabled; the API refuses Run all live).
//  2) The confirmation lists the right things: the dry run it promotes, files + pages (G), backups + tables (B); Cancel does nothing.
//  3) Undo appears only after a live run: shown exactly on the stages with a live publish in the history; can't act as agent.
// Since 3 Nov every stage A–H has run live, so 2) simulates a newer check for G (route) to reopen its Publish live….
// Run: MC_AGENT_PASSWORD=… MC_BASE_URL=https://apps-dashboard-lilac.vercel.app EVIDENCE_DIR=… npx playwright test tests/e2e/bau-live-page.spec.js
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { mcBaseUrl, mcLogin, mcApi } from '../helpers/mc.mjs';

const EVIDENCE = process.env.EVIDENCE_DIR || path.join(process.cwd(), 'tmp', 'bau-live-page');
const FILE_STAGES = ['A', 'C', 'D', 'E', 'F', 'G', 'H'];
let session;

test.use({ channel: 'chrome' });
test.beforeAll(async () => { session = await mcLogin('agent'); fs.mkdirSync(EVIDENCE, { recursive: true }); });

const latestRunId = async () => (await mcApi('/api/update-all?run=latest', { token: session.token })).run?.id || null;
const shot = (page, name) => page.screenshot({ path: path.join(EVIDENCE, `${name}.png`), fullPage: true });

/** The agent account signs in as role alan (it could really publish): the page may never POST in this spec. */
async function openPage(page, query = '') {
  await page.route((u) => u.pathname === '/api/update-all', (route) => (route.request().method() === 'POST' ? route.abort() : route.fallback()));
  await page.addInitScript((s) => { sessionStorage.setItem('mc_session_token', s.token); sessionStorage.setItem('mc_session_role', s.role); }, session);
  await page.goto(`${mcBaseUrl()}/bau-workflow.html${query}`);
  await expect(page.getByTestId('stage-run-A')).toBeVisible({ timeout: 30000 });
}

test('1. Live is only on the per-stage buttons; Run all stays dry', async ({ page }) => {
  await openPage(page);
  await expect(page.getByTestId('run-all-live')).toBeDisabled();
  await expect(page.getByTestId('run-all-live-note')).toBeVisible();
  for (const s of [...FILE_STAGES, 'B']) await expect(page.getByTestId(`stage-live-${s}`)).toBeVisible();
  await expect(page.getByTestId('stage-live-I')).toHaveText('Start full audit ①…');
  const runAllLive = await mcApi('/api/update-all', { token: session.token, method: 'POST', body: { action: 'start', mode: 'live' } }).catch((e) => e);
  expect([400, 403]).toContain(runAllLive.status);
  await shot(page, '1-live-only-on-stage-buttons');
});

test('2. the confirmation lists the checked build and what it would publish; Cancel does nothing', async ({ page }) => {
  await page.route((u) => u.pathname === '/api/update-all' && u.searchParams.has('run'), async (route) => {
    const real = await (await route.fetch()).json();
    real.stages.history.dry.G = { ...real.stages.history.dry.G, run_id: 'simulated-newer-dry-g', finished_at: new Date().toISOString(), status: 'ok' };
    await route.fulfill({ json: real });
  });
  await openPage(page);
  const before = await latestRunId();
  const plan = await mcApi('/api/update-all?live_plan=G', { token: session.token });
  await page.getByTestId('stage-live-G').click();
  await expect(page.getByTestId('live-confirm-title')).toContainText('stage G');
  await expect(page.getByTestId('live-confirm-dry')).toContainText(plan.dry.run_id.slice(0, 8));
  await expect(page.getByTestId('live-confirm-files')).toContainText(`(${plan.files.length})`);
  await expect(page.getByTestId('live-confirm-pages')).toContainText(`(${plan.pages.length})`);
  expect(plan.files.length).toBeGreaterThan(0);
  expect(plan.pages.length).toBeGreaterThan(0);
  await expect(page.getByTestId('live-confirm-publish')).toBeVisible();
  await shot(page, '2a-confirm-G-files-and-pages');
  await page.getByTestId('live-confirm-cancel').click();
  await expect(page.getByTestId('live-modal')).toBeHidden();
  await page.getByTestId('stage-live-B').click();
  await expect(page.getByTestId('live-confirm-backups')).toContainText('(5)');
  await expect(page.getByTestId('live-confirm-tables')).toBeVisible();
  await expect(page.getByTestId('live-confirm-files')).toHaveCount(0);
  await shot(page, '2b-confirm-B-backups-and-tables');
  await page.getByTestId('live-confirm-cancel').click();
  await expect(page.getByTestId('live-modal')).toBeHidden();
  await page.waitForTimeout(3000);
  expect(await latestRunId()).toBe(before);
});

test('3. Undo appears only after a live run; its confirmation opens and Cancel does nothing', async ({ page }) => {
  await openPage(page);
  const h = (await mcApi('/api/update-all?run=latest', { token: session.token })).stages.history.live_done || {};
  for (const s of [...FILE_STAGES, 'B']) {
    const live = !!(h[s] && ['ok', 'warn'].includes(h[s].status) && !h[s].undo_of);
    await expect(page.getByTestId(`stage-undo-${s}`), `stage ${s}`).toHaveCount(live ? 1 : 0);
  }
  await expect(page.getByTestId('stage-undo-I')).toHaveCount(0);
  const before = await latestRunId();
  await page.getByTestId('stage-undo-F').click();
  await expect(page.getByTestId('undo-confirm-title')).toContainText('stage F');
  await expect(page.getByTestId('undo-confirm-what')).toContainText('commit');
  await shot(page, '3-undo-confirm-F');
  await page.getByTestId('undo-confirm-cancel').click();
  await expect(page.getByTestId('live-modal')).toBeHidden();
  await page.waitForTimeout(3000);
  expect(await latestRunId()).toBe(before);
});
