// BAU Last runs lines wrap instead of cutting off, and every control has a tip (Alan 4 Nov 11:23). Read-only with the
// shared write guard: opening the Steps log, the progress window and a confirmation box posts nothing; Cancel only.
// BAU_LOCAL_PAGE=1 serves the local bau-workflow.html / bau-progress.js in place of production (API still production).
// Run: MC_AGENT_PASSWORD=… MC_BASE_URL=https://apps-dashboard-lilac.vercel.app EVIDENCE_DIR=… npx playwright test tests/e2e/bau-last-runs-wrap.spec.js
import { test, expect } from '../helpers/bau-guard.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { mcBaseUrl, mcLogin, mcApi } from '../helpers/mc.mjs';

const EVIDENCE = process.env.EVIDENCE_DIR || path.join(process.cwd(), 'tmp', 'bau-last-runs-wrap');
let session;
test.use({ channel: 'chrome' });
test.beforeAll(async () => { session = await mcLogin('agent'); fs.mkdirSync(EVIDENCE, { recursive: true }); });

async function openPage(page) {
  if (process.env.BAU_LOCAL_PAGE === '1') {
    for (const f of ['bau-workflow.html', 'bau-progress.js']) {
      await page.route((u) => u.pathname === `/${f}`, (r) => r.fulfill({ body: fs.readFileSync(f, 'utf8'), contentType: f.endsWith('.js') ? 'text/javascript' : 'text/html' }));
    }
  }
  await page.addInitScript((s) => { sessionStorage.setItem('mc_session_token', s.token); sessionStorage.setItem('mc_session_role', s.role); localStorage.removeItem('bau_dismissed_run'); }, session);
  await page.goto(`${mcBaseUrl()}/bau-workflow.html`);
  await expect(page.getByTestId('stage-run-A')).toBeVisible({ timeout: 30000 });
}
/** Visible buttons, links, summaries and tick boxes with no tip on themselves or an ancestor. */
const untipped = (page) => page.evaluate(() => [...document.querySelectorAll('button, a, summary, input[type="checkbox"]')]
  .filter((e) => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden' && !e.closest('[data-tip]'))
  .map((e) => `${e.tagName} "${(e.textContent || e.id || '').trim().slice(0, 40)}"`));

for (const [w, h] of [[1440, 900], [1920, 1080]]) {
  test(`Last runs lines wrap, none cut off; B's commit link is whole (${w})`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await openPage(page);
    const cut = await page.locator('#stageRows .hline').evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth || getComputedStyle(e).textOverflow === 'ellipsis').map((e) => e.textContent.trim()));
    expect(cut).toEqual([]);
    const live = (await mcApi('/api/update-all?run=latest', { token: session.token })).stages.history.live_done.B;
    await expect(page.locator('tr[data-stage="B"] [data-testid="stage-history-live"] [data-testid="commit-link"]')).toHaveText(String(live.export_commit).slice(0, 7));
    const tagsLeft = await page.locator('#stageRows .hline .hl-text').evaluateAll((els) => els.map((e) => [e.getBoundingClientRect().left, e.getClientRects().length]));
    for (const [left] of tagsLeft) expect(left).toBeGreaterThan(0);
    if (w === 1440) {
      for (const id of 'BDHI') await page.locator(`tr[data-stage="${id}"]`).screenshot({ path: path.join(EVIDENCE, `row-${id}-1440.png`) });
    }
  });
}

test('every visible button, link, summary and tick box has a tip (page, Steps log, progress window, confirmation)', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await openPage(page);
  expect(await untipped(page)).toEqual([]);
  await page.getByTestId('steps-summary').click();
  await expect(page.getByTestId('update-all-steps')).toBeVisible();
  expect(await untipped(page)).toEqual([]);
  await page.getByTestId('open-progress').click();
  await expect(page.getByTestId('pg-close')).toBeVisible();
  expect(await untipped(page)).toEqual([]);
  await page.getByTestId('pg-close').click();
  await page.getByTestId('stage-live-A').click();
  await expect(page.getByTestId('live-confirm-title')).toBeVisible();
  expect(await untipped(page)).toEqual([]);
  await page.getByTestId('live-confirm-cancel').click();
  await page.mouse.move(2, 2);
  await page.locator('.links a').first().hover();
  await expect(page.getByTestId('tip')).toHaveText('Opens the old step-by-step manual checklist this page replaced.');
  await page.locator('.links a').nth(1).hover();
  await expect(page.getByTestId('tip')).toHaveText('Opens Mission Control, the task tracker.');
  const files = page.locator('#runStatus [data-testid="run-status-files"] summary');
  if (await files.count()) {
    await files.hover();
    await expect(page.getByTestId('tip')).toHaveText(/^Shows the list of files this (check would publish|run published)\.$/);
  }
});
