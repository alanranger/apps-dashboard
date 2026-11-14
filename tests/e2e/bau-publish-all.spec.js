// Check all / Publish all buttons (Alan 14 Nov): Publish all disabled until a finished Check all;
// partial OK list when WARN/removals; never auto-publishes. Read-only route mock — no live posts.
import { test, expect } from '../helpers/bau-guard.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { mcBaseUrl, mcLogin } from '../helpers/mc.mjs';
import { publishAllPlan } from '../../runner/publish-all-plan.mjs';

const EVIDENCE = process.env.EVIDENCE_DIR || path.join(process.cwd(), 'tmp', 'bau-publish-all');
let session;
test.use({ channel: 'chrome', viewport: { width: 1280, height: 900 } });
test.beforeAll(async () => { session = await mcLogin('agent'); fs.mkdirSync(EVIDENCE, { recursive: true }); });

const ok = () => ({ status: 'ok', removals_unexplained: 0, run_id: 'dry-ok-0000' });
const allOk = Object.fromEntries('ABCDEFGH'.split('').map((id) => [id, ok()]));
const checkAll = (results) => ({
  id: 'checkall-sim-0000', mode: 'dry', stages: null, status: 'succeeded', finished_at: new Date().toISOString(), stage_results: results
});

const latestGet = (url) => url.pathname === '/api/update-all' && url.searchParams.has('run');
async function openWith(page, publish_all, live = { can_publish: true }) {
  await page.addInitScript((s) => {
    sessionStorage.setItem('mc_session_token', s.token);
    sessionStorage.setItem('mc_session_role', s.role);
  }, session);
  await page.route(latestGet, async (route) => {
    const real = await (await route.fetch()).json();
    await route.fulfill({
      json: {
        ...real,
        run: { ...(real.run || {}), status: 'succeeded', mode: 'dry', stages: null },
        live: { ...(real.live || {}), ...live },
        publish_all,
        server_now: new Date().toISOString()
      }
    });
  });
  for (const f of ['bau-workflow.html']) {
    if (process.env.BAU_LOCAL_PAGE) {
      await page.route((u) => u.pathname === `/${f}`, (r) => r.fulfill({ path: f, contentType: 'text/html' }));
    }
  }
  await page.goto(`${mcBaseUrl()}/bau-workflow.html`);
  await expect(page.getByTestId('update-all-start')).toBeVisible({ timeout: 30000 });
}

test('Publish all disabled before Check all; active after all-OK; partial label with WARN+removals', async ({ page }) => {
  await openWith(page, publishAllPlan(null));
  const btn = page.getByTestId('publish-all');
  await expect(btn).toBeDisabled();
  await expect(btn).toHaveText('Publish all');
  await expect(page.getByTestId('update-all-start')).toHaveText('Check all stages');
  await page.screenshot({ path: path.join(EVIDENCE, '1-publish-all-disabled.png') });

  await openWith(page, publishAllPlan(checkAll(allOk)));
  await expect(page.getByTestId('publish-all')).toBeEnabled();
  await expect(page.getByTestId('publish-all')).toHaveText('Publish all');
  await page.screenshot({ path: path.join(EVIDENCE, '2-publish-all-ready.png') });

  const partial = publishAllPlan(checkAll({
    ...allOk,
    D: { status: 'warn', removals_unexplained: 0 },
    E: { status: 'ok', removals_unexplained: 2 }
  }));
  await openWith(page, partial);
  await expect(page.getByTestId('publish-all')).toBeEnabled();
  await expect(page.getByTestId('publish-all')).toContainText('6 of 8');
  await page.getByTestId('publish-all').click();
  await expect(page.getByTestId('publish-all-will')).toBeVisible();
  await expect(page.getByTestId('publish-all-skip')).toContainText('D');
  await expect(page.getByTestId('publish-all-skip')).toContainText('E');
  await page.screenshot({ path: path.join(EVIDENCE, '3-publish-all-partial-confirm.png') });
});
