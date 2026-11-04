// BAU B "re-read only changed pages" (Alan 3 Nov): the Publish live confirmation shows the pages B re-reads in full
// (from its test run), their count and the "Force full re-read" option. Read-only: live_plan=B is simulated; Cancel only.
// Run: MC_AGENT_PASSWORD=… MC_BASE_URL=https://apps-dashboard-lilac.vercel.app EVIDENCE_DIR=… npx playwright test tests/e2e/bau-b-refetch.spec.js
import { test, expect } from '../helpers/bau-guard.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { mcBaseUrl, mcLogin } from '../helpers/mc.mjs';

const EVIDENCE = process.env.EVIDENCE_DIR || path.join(process.cwd(), 'tmp', 'bau-b-refetch');
let session;
test.use({ channel: 'chrome', viewport: { width: 1280, height: 1000 } });
test.beforeAll(async () => { session = await mcLogin('agent'); fs.mkdirSync(EVIDENCE, { recursive: true }); });

const refetch = { checked: 520, reingest: 3, unchanged: 517, by_reason: { unchanged: 517, changed: 2, new: 1 }, force: false,
  list: [{ url: 'https://www.alanranger.com/blog-on-photography/how-to-find-your-photography-style', reason: 'changed' },
    { url: 'https://www.alanranger.com/photography-services-near-me/lightroom-courses-for-beginners-coventry', reason: 'changed' },
    { url: 'https://www.alanranger.com/blog-on-photography/a-new-post', reason: 'new' }] };

test('B confirmation: pages re-read in full (count, reasons, list) and the Force full re-read tick box, off by default', async ({ page }) => {
  await page.route((u) => u.pathname === '/api/update-all' && u.searchParams.get('live_plan') === 'B', async (route) => {
    const real = await (await route.fetch()).json();
    await route.fulfill({ json: { ...real, refusal: null, db: { ...(real.db || { backups: [], expected: [], file: 'csv processed/05-event-product-mappings-latest.csv' }), refetch } } });
  });
  await page.addInitScript((s) => { sessionStorage.setItem('mc_session_token', s.token); sessionStorage.setItem('mc_session_role', s.role); }, session);
  await page.goto(`${mcBaseUrl()}/bau-workflow.html`);
  await page.getByTestId('stage-live-B').click({ timeout: 30000 });
  await expect(page.getByTestId('live-confirm-refetch')).toContainText('Pages re-read in full: 3 of 520');
  await expect(page.getByTestId('live-confirm-refetch')).toContainText('changed 2, new 1');
  await expect(page.getByTestId('live-confirm-refetch')).toContainText('517 unchanged are only checked');
  await expect(page.getByTestId('live-confirm-refetch-list')).toContainText('(3)');
  await expect(page.getByTestId('force-full-reread')).not.toBeChecked();
  await page.getByTestId('live-confirm-refetch-list').locator('summary').click();
  await page.screenshot({ path: path.join(EVIDENCE, 'b-confirm-refetch.png') });
  await page.getByTestId('live-confirm-cancel').click();
  await expect(page.getByTestId('live-modal')).toBeHidden();
});
