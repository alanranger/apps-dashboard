// BAU stage I starts ① and finishes (Alan 4 Nov, option 1): the Stages row for I shows the latest ① run's own status;
// a simulated live I shows "Full audit ① started … runs in the background"; a simulated Run all finishes after I started ①.
// Read-only: only the page's GET of the latest run is simulated; nothing is posted.
// Run: MC_AGENT_PASSWORD=… MC_BASE_URL=https://apps-dashboard-lilac.vercel.app EVIDENCE_DIR=… npx playwright test tests/e2e/bau-stage-i.spec.js
import { test, expect } from '../helpers/bau-guard.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { mcBaseUrl, mcLogin } from '../helpers/mc.mjs';

const EVIDENCE = process.env.EVIDENCE_DIR || path.join(process.cwd(), 'tmp', 'bau-stage-i');
let session;
test.use({ channel: 'chrome', viewport: { width: 1280, height: 1000 } });
test.beforeAll(async () => { session = await mcLogin('agent'); fs.mkdirSync(EVIDENCE, { recursive: true }); });

const latestGet = (u) => u.pathname === '/api/update-all' && u.searchParams.has('run');
const STARTED = 'Full audit ① started (run 1234abcd). It runs in the background (about 3 h). Results appear in the AI GEO audit app and the Monday brief.';
const ago = (s) => new Date(Date.now() - s * 1000).toISOString();
async function openPage(page) {
  await page.addInitScript((s) => { sessionStorage.setItem('mc_session_token', s.token); sessionStorage.setItem('mc_session_role', s.role); localStorage.removeItem('bau_dismissed_run'); }, session);
  await page.goto(`${mcBaseUrl()}/bau-workflow.html`);
  await expect(page.getByTestId('stage-run-A')).toBeVisible({ timeout: 30000 });
}
async function simulate(page, fake) {
  await page.route(latestGet, async (route) => { const real = await (await route.fetch()).json(); await route.fulfill({ json: fake(real) }); });
}

test('real page: the Stages row for I shows the latest ① run status', async ({ page }) => {
  await openPage(page);
  const status = page.locator('tr[data-stage="I"] [data-testid="audit-status"]');
  await expect(status).toBeVisible();
  await expect(status).toContainText(/① (latest|running)/);
  await page.locator('tr[data-stage="I"]').screenshot({ path: path.join(EVIDENCE, 'stage-i-row.png') });
});

test('a live I finishes as soon as ① has started; the row shows ① running in the background', async ({ page }) => {
  await simulate(page, (real) => ({ ...real,
    stages: { ...real.stages, audit: { id: '1234abcd-run', status: 'running', started_at: ago(60), last_tick_at: ago(30), pages_planned: 443, pages_checked: 14, cursor: 14, findings_open: 2 } },
    run: { id: 'simulated-live-i', mode: 'live', status: 'succeeded', stages: ['I'], options: {}, include_audit: true, needs_alan: [], requested_at: ago(90), started_at: ago(80), finished_at: ago(60),
      stage_results: { I: { status: 'ok', mode: 'live' } } },
    steps: [{ ord: 1, step_id: 'preflight', name: 'Pre-flight checks', status: 'ok', duration_ms: 3000 },
      { ord: 17, step_id: 'audit', name: '① Full audit → broken links → ② score', status: 'ok', duration_ms: 12000, plain: STARTED, notes: [{ level: 'info', text: STARTED }] },
      { ord: 18, step_id: 'summary', name: 'Summary', status: 'ok', duration_ms: 300 }] }));
  await openPage(page);
  await expect(page.locator('#runStatus')).toContainText('Full audit ① started — stage I');
  await expect(page.locator('#runStatus')).toContainText('① runs in the background (about 3 h)');
  await expect(page.locator('#runStatus')).not.toContainText('No files published');
  await expect(page.locator('tr[data-step="audit"]')).toContainText('runs in the background (about 3 h)');
  await expect(page.locator('tr[data-stage="I"] [data-testid="audit-status"]')).toContainText('① running since');
  await expect(page.locator('tr[data-stage="I"] [data-testid="audit-status"]')).toContainText('14 of 443 pages');
  await page.locator('#runStatus').screenshot({ path: path.join(EVIDENCE, 'live-i-started.png') });
});

test('Run all live finishes after I has started ① (does not wait for it)', async ({ page }) => {
  await simulate(page, (real) => ({ ...real,
    run: { id: 'simulated-run-all', mode: 'live', status: 'succeeded', stages: null, options: {}, include_audit: true, needs_alan: [], requested_at: ago(1200), started_at: ago(1190), finished_at: ago(5),
      stage_results: Object.fromEntries('ABCDEFGHI'.split('').map((s) => [s, { status: 'ok', mode: 'live' }])) },
    steps: (real.registry || []).map((d) => ({ ord: d.ord, step_id: d.id, name: d.name, status: 'ok', duration_ms: d.id === 'audit' ? 12000 : 1000, ...(d.id === 'audit' ? { plain: STARTED } : {}) })) }));
  await openPage(page);
  await page.getByTestId('open-progress').click();
  await expect(page.locator('#pgModal').getByTestId('pg-result')).toContainText('Published live');
  await expect(page.locator('#pgModal [data-testid="pg-stages"] li[data-stage="I"]')).toHaveAttribute('data-status', 'ok');
  await page.screenshot({ path: path.join(EVIDENCE, 'run-all-finished.png') });
});
