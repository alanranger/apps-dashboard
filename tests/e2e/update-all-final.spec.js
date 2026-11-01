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

/** VERIFY_RUN_ID=<id>: re-check a run this test already started from the page button (no new run). */
async function verifyExisting(page, token, id) {
  const data = await (await fetch(`${mcBaseUrl()}/api/update-all?run=${id}`, { headers: { 'x-mc-token': token } })).json();
  fs.writeFileSync(path.join(EVIDENCE, 'run.json'), JSON.stringify(data, null, 2));
  await page.goto(`${mcBaseUrl()}/bau-workflow.html?run=${id}`);
  await expect(page.locator('tr[data-step="summary"]')).toHaveAttribute('data-status', 'ok', { timeout: 30000 });
  await page.screenshot({ path: path.join(EVIDENCE, '3-finished.png'), fullPage: true });
  return { data, runId: id };
}

async function startAndWait(page, token) {
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
  const summaryStatus = (data.run.summary?.coverage?.orphans || []).length ? 'warn' : 'ok';
  await expect(page.locator('tr[data-step="summary"]')).toHaveAttribute('data-status', summaryStatus, { timeout: 30000 });
  await page.screenshot({ path: path.join(EVIDENCE, '3-finished.png'), fullPage: true });
  return { data, runId };
}

test('page button only: the scheduled runner picks the run up and the full dry run ends with 0 fail and only ① skipped', async ({ page }) => {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const { token } = await mcLogin('agent');
  await page.addInitScript((t) => { sessionStorage.setItem('mc_session_token', t); sessionStorage.setItem('mc_session_role', 'agent'); }, token);
  const { data, runId } = process.env.VERIFY_RUN_ID ? await verifyExisting(page, token, process.env.VERIFY_RUN_ID) : await startAndWait(page, token);
  expect(data.run.id).toBe(runId);
  expect(data.run.requested_by).not.toBe('runner-cli');
  expect(['succeeded', 'warned']).toContain(data.run.status);
  const byStatus = (st) => data.steps.filter((s) => s.status === st).map((s) => s.step_id);
  expect(byStatus('fail')).toEqual([]);
  expect(byStatus('skipped')).toEqual(['audit']);
  expect(byStatus('pending')).toEqual([]);
  await expect(page.getByTestId('needs-alan')).toBeVisible();
  const needs = data.run.needs_alan || [];
  if (process.env.EXPECT_NEEDS_EMPTY === '1') expect(needs).toEqual([]);
  if (needs.length) await expect(page.getByTestId('needs-item')).toHaveCount(needs.length);
  else await expect(page.getByTestId('needs-empty')).toHaveText('Nothing needs you.');
  const step = (id) => data.steps.find((s) => s.step_id === id);
  if (!INCLUDE_AUDIT) {
    expect(step('audit').details).toContain('skipped — not selected');
    expect(step('audit').notes.map((n) => n.level)).toEqual(['info']);
    await expect(page.getByTestId('run-audit')).toHaveText('Full audit: not selected');
  }
  const blog = step('blog_posts').counts;
  expect(blog.would_regenerate).toBe(Number(process.env.EXPECT_REGENERATE || 9));
  expect(blog.regenerate_scope).toContain('all 6 file types');
  expect(Object.keys(blog.files_per_post || {})).toHaveLength(blog.would_regenerate);
  expect(blog.deleted_posts).toBe(0);
  expect(step('landing_pages').counts.live_mode).toBe('live');
  expect(step('landing_pages').counts.business_rating_nodes).toBe(0);
  expect(step('event_index').status).toBe('ok');
  const d07 = step('product_schema').counts.diff_07;
  expect(d07.duplicates).toBe(0);
  expect(d07.unexplained).toBe(0);
  expect(step('final_ingest').counts.product_schema).toMatch(/ 0 dup$/);
  const shadow = step('reviews').counts.shadow_matcher;
  expect(shadow.mode).toBe('shadow (report only)');
  expect(shadow.orders_loaded).toBeGreaterThan(0);
  expect(shadow.backtest.decisions).toBeGreaterThan(125);
  expect(data.run.stages).toBeNull();
  expect(Object.keys(data.run.stage_results).sort()).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']);
  const levels = { info: 0, check: 0, problem: 0 };
  for (const s of data.steps) for (const n of s.notes || []) levels[n.level] += 1;
  expect(data.run.summary.levels).toEqual(levels);
  for (const level of Object.keys(levels)) await expect(page.getByTestId(`summary-${level}-count`).locator('strong')).toHaveText(String(levels[level]));
  await expect(page.locator('tr[data-step="blog_posts"]').getByTestId('note-check')).toHaveCount(0);
  fs.writeFileSync(path.join(EVIDENCE, 'product-07-diff.json'), JSON.stringify(step('product_schema').counts.diff_07, null, 2));
  fs.writeFileSync(path.join(EVIDENCE, 'review-matcher-shadow-summary.json'), JSON.stringify(shadow, null, 2));
  await expect(page.locator('h1')).toHaveText('BAU Monthly');
  const coverage = data.run.summary?.coverage;
  expect(coverage.orphans).toHaveLength(Number(process.env.EXPECT_ORPHANS || 0));
  await expect(page.getByTestId('coverage-line')).toHaveText(coverage.line);
  const info = data.run.summary?.info || [];
  await expect(page.getByTestId('summary-info-item')).toHaveCount(info.length);
});
