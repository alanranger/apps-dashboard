// Final proof: one full DRY run started from the page button only. Nothing is run by hand: the Windows task
// AlanUpdateAllRunner (--once every 5 minutes) must pick the run up. Waits for the run to finish, then checks the
// statuses, the Needs Alan panel and the summary, and saves a screenshot + the run JSON as evidence.
// Run: MC_AGENT_PASSWORD=… MC_BASE_URL=https://apps-dashboard-lilac.vercel.app EVIDENCE_DIR=… npx playwright test tests/e2e/update-all-final.spec.js
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { mcBaseUrl, mcLogin } from '../helpers/mc.mjs';

const EVIDENCE = process.env.EVIDENCE_DIR || path.join(process.cwd(), 'tmp', 'update-all-final');
const FINISHED = ['succeeded', 'warned', 'failed', 'cancelled'];

async function latest(token) {
  const res = await fetch(`${mcBaseUrl()}/api/update-all?run=latest`, { headers: { 'x-mc-token': token } });
  return res.json();
}

test.use({ channel: 'chrome' });
test.describe.configure({ timeout: 3 * 60 * 60 * 1000 });

const INCLUDE_AUDIT = process.env.INCLUDE_AUDIT === '1';

test('page button only: the scheduled runner picks the run up and the full dry run ends with 0 fail and only ① skipped', async ({ page }) => {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const { token } = await mcLogin('agent');
  await page.addInitScript((t) => { sessionStorage.setItem('mc_session_token', t); sessionStorage.setItem('mc_session_role', 'agent'); }, token);
  await page.goto(`${mcBaseUrl()}/bau-workflow.html`);
  await expect(page.getByTestId('include-audit')).toBeChecked();
  if (!INCLUDE_AUDIT) await page.getByTestId('include-audit').uncheck();
  await page.getByTestId('update-all-start').click();
  await expect.poll(async () => (await latest(token)).run?.status, { timeout: 30000 }).toBe('requested');
  const runId = (await latest(token)).run.id;
  expect((await latest(token)).run.include_audit).toBe(INCLUDE_AUDIT);
  await expect(page.getByTestId('action-msg')).toContainText('Waiting for the PC runner');
  await page.screenshot({ path: path.join(EVIDENCE, '1-requested.png'), fullPage: true });

  await expect.poll(async () => (await latest(token)).run?.status, { timeout: 7 * 60 * 1000, intervals: [15000] }).toBe('running');
  await expect(page.getByTestId('action-msg')).toContainText('Running', { timeout: 15000 });
  await page.screenshot({ path: path.join(EVIDENCE, '2-running.png'), fullPage: true });

  await expect.poll(async () => FINISHED.includes((await latest(token)).run?.status), { timeout: 150 * 60 * 1000, intervals: [60000] }).toBe(true);
  const data = await latest(token);
  fs.writeFileSync(path.join(EVIDENCE, 'run.json'), JSON.stringify(data, null, 2));
  await page.reload();
  await expect(page.locator('tr[data-step="summary"]')).toHaveAttribute('data-status', 'ok', { timeout: 30000 });
  await page.screenshot({ path: path.join(EVIDENCE, '3-finished.png'), fullPage: true });

  expect(data.run.id).toBe(runId);
  expect(data.run.requested_by).not.toBe('runner-cli');
  expect(['succeeded', 'warned']).toContain(data.run.status);
  const byStatus = (st) => data.steps.filter((s) => s.status === st).map((s) => s.step_id);
  expect(byStatus('fail')).toEqual([]);
  expect(byStatus('skipped')).toEqual(['audit']);
  expect(byStatus('pending')).toEqual([]);
  await expect(page.getByTestId('needs-alan')).toBeVisible();
  const needs = data.run.needs_alan || [];
  if (needs.length) await expect(page.getByTestId('needs-item')).toHaveCount(needs.length);
  else await expect(page.getByTestId('needs-empty')).toHaveText('Nothing needs you.');
  const step = (id) => data.steps.find((s) => s.step_id === id);
  if (!INCLUDE_AUDIT) {
    expect(step('audit').warnings).toContain('skipped — not selected');
    await expect(page.getByTestId('run-audit')).toHaveText('Full audit: not selected');
  }
  expect(step('blog_posts').counts.would_regenerate).toBe(Number(process.env.EXPECT_REGENERATE || 9));
  expect(step('landing_pages').counts.live_mode).toBe('report-only (P5)');
  const info = data.run.summary?.info || [];
  await expect(page.getByTestId('summary-info-item')).toHaveCount(info.length);
});
