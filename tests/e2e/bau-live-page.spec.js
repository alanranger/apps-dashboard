// BAU Monthly Live on the page (Claude/Alan 3 Nov, step 6), as the TEST account (agent). Nothing is ever published:
// the API refuses Live to anyone but Alan, and only when UPDATE_ALL_LIVE_ENABLED=1.
//  1) Live is only on the per-stage buttons; Run all stays dry (its Live option is disabled; the API refuses Run all live).
//  2) The confirmation lists the right things: the dry run it promotes, files + pages (G), backups + tables (B); Cancel does nothing.
//  3) Undo appears only after a live run: hidden without one; shown on the test target (?simulateLive=F), and can't act.
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

async function openPage(page, query = '') {
  await page.addInitScript((s) => { sessionStorage.setItem('mc_session_token', s.token); sessionStorage.setItem('mc_session_role', s.role); }, session);
  await page.goto(`${mcBaseUrl()}/bau-workflow.html${query}`);
  await expect(page.getByTestId('stage-run-A')).toBeVisible({ timeout: 30000 });
}

test('1. Live is only on the per-stage buttons; Run all stays dry', async ({ page }) => {
  await openPage(page);
  await expect(page.getByTestId('run-all-live')).toBeDisabled();
  await expect(page.getByTestId('run-all-live-note')).toBeVisible();
  for (const s of [...FILE_STAGES, 'B']) await expect(page.getByTestId(`stage-live-${s}`)).toBeVisible();
  await expect(page.getByTestId('stage-live-I')).toHaveCount(0);
  const runAllLive = await mcApi('/api/update-all', { token: session.token, method: 'POST', body: { action: 'start', mode: 'live' } }).catch((e) => e);
  expect(runAllLive.status).toBe(403);
  await shot(page, '1-live-only-on-stage-buttons');
});

test('2. the confirmation lists the dry run and what it would publish; Cancel does nothing', async ({ page }) => {
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
  await expect(page.getByTestId('live-confirm-publish')).toBeDisabled();
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

test('3. Undo appears only after a live run (test target: ?simulateLive=F)', async ({ page }) => {
  await openPage(page);
  for (const s of FILE_STAGES) await expect(page.getByTestId(`stage-undo-${s}`)).toHaveCount(0);
  const before = await latestRunId();
  await openPage(page, '?simulateLive=F');
  await expect(page.getByTestId('stage-undo-F')).toBeVisible();
  await expect(page.getByTestId('stage-undo-G')).toHaveCount(0);
  await page.getByTestId('stage-undo-F').click();
  await expect(page.getByTestId('undo-confirm-title')).toContainText('stage F');
  await expect(page.getByTestId('undo-confirm-go')).toBeDisabled();
  await shot(page, '3-undo-on-test-target');
  await page.getByTestId('undo-confirm-cancel').click();
  await expect(page.getByTestId('live-modal')).toBeHidden();
  const undo = await mcApi('/api/update-all', { token: session.token, method: 'POST', body: { action: 'undo', stage: 'F' } }).catch((e) => e);
  expect(undo.status).toBe(403);
  expect(await latestRunId()).toBe(before);
});
