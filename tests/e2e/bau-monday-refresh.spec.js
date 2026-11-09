// BAU pre-flight vs the Monday full refresh (Claude QUESTION 9 Nov, (u)): a live A stopped while the refresh is running
// shows "Run when it finishes" on the banner and in the progress window, and a queued run says it waits behind the refresh.
// Read-only: only the page's GET of the latest run is replaced; the button's POST is blocked by the guard and checked.
// Run: MC_AGENT_PASSWORD=… MC_BASE_URL=https://apps-dashboard-lilac.vercel.app [BAU_LOCAL_UI=1] npx playwright test tests/e2e/bau-monday-refresh.spec.js
import { test, expect } from '../helpers/bau-guard.mjs';
import { mcBaseUrl, mcLogin } from '../helpers/mc.mjs';

let session;
test.use({ channel: 'chrome', viewport: { width: 1280, height: 1000 } });
test.beforeAll(async () => { session = await mcLogin('agent'); });

const at = (s) => new Date(Date.now() - s * 1000).toISOString();
const later = (s) => new Date(Date.now() + s * 1000).toISOString();
const TEXT = 'The Monday full refresh is running (started 00:00, step 17 of 29). Try again after it finishes, about 05:19.';
const REFRESH = { state: 'running', run_id: 'ceo_monday_full_refresh/2026-11-09', started_at: '2026-11-09T00:00:02Z', step: 17, steps: 29, eta: '2026-11-09T05:19:02Z', queue_option: true };
const run = (extra) => ({ id: 'simulated-mon0-0000', mode: 'live', stages: ['A'], options: {}, requested_at: at(120), started_at: at(100), include_audit: false, needs_alan: [], stage_results: {}, ...extra });
const blocked = () => ({
  run: run({ status: 'failed', finished_at: at(60), error: `Pre-flight checks: ${TEXT}` }),
  steps: [{ ord: 1, step_id: 'preflight', name: 'Pre-flight checks', status: 'fail', error: TEXT, counts: { monday_refresh: REFRESH },
    notes: [{ level: 'problem', text: TEXT, todo: 'press Run when it finishes to queue this run behind it (it starts by itself once the refresh is done), or try again after about 05:19' }] }]
});
const queued = () => ({ run: run({ status: 'requested', cooldown_until: later(600), options: { wait_for_refresh: true, refresh_wait: { started_at: REFRESH.started_at, step: 18, steps: 29, eta: '2026-11-09T05:19:02Z' } } }), steps: [] });

const latestGet = (url) => url.pathname === '/api/update-all' && url.searchParams.has('run');
async function simulate(page, fake) {
  await page.unroute(latestGet).catch(() => {});
  await page.route(latestGet, async (route) => {
    const real = await (await route.fetch()).json();
    await route.fulfill({ json: { ...real, runner: null, ...fake(), server_now: new Date().toISOString() } });
  });
}
async function openPage(page) {
  // BAU_LOCAL_UI=1: serve this checkout's page files (before they are deployed); the API stays the real, read-only one.
  if (process.env.BAU_LOCAL_UI) for (const f of ['bau-workflow.html', 'bau-progress.js']) await page.route((u) => u.pathname === `/${f}`, (r) => r.fulfill({ path: f }));
  await page.addInitScript((s) => { sessionStorage.setItem('mc_session_token', s.token); sessionStorage.setItem('mc_session_role', s.role); localStorage.removeItem('bau_dismissed_run'); }, session);
  await page.goto(`${mcBaseUrl()}/bau-workflow.html`);
  await expect(page.getByTestId('stage-run-A')).toBeVisible({ timeout: 30000 });
}

test.describe('Run when it finishes', () => {
  test.use({ expectBlockedWrites: true });
  test('blocked pre-flight: real start / step / ETA, no "another day", and the queue button posts wait_for_refresh', async ({ page, blockedWrites }) => {
    await simulate(page, blocked);
    await openPage(page);
    await expect(page.getByTestId('run-status-error')).toContainText(TEXT);
    await expect(page.locator('#runStatus')).not.toContainText('another day');
    await page.getByTestId('run-when-finishes').click();
    await expect.poll(() => blockedWrites.length).toBe(1);
    expect(JSON.parse(blockedWrites[0].body)).toEqual({ action: 'resume', run_id: 'simulated-mon0-0000', wait_for_refresh: true });
    await page.getByTestId('open-progress').click();
    await expect(page.locator('#pgModal').getByTestId('pg-run-when-finishes')).toBeVisible();
  });
});

test('queued behind the refresh: the banner and progress window say so (not the Squarespace cool-down)', async ({ page }) => {
  await simulate(page, queued);
  await openPage(page);
  await expect(page.getByTestId('run-status-queued')).toContainText('Queued behind the Monday full refresh (step 18 of 29, about 05:19)');
  await expect(page.getByTestId('run-status-queued')).not.toContainText('Squarespace');
  await page.getByTestId('open-progress').click();
  await expect(page.locator('#pgModal').getByTestId('pg-queued')).toContainText('Queued behind the Monday full refresh (step 18 of 29, about 05:19)');
});
