// BAU hover tips (Alan 4 Nov 10:45): every control shows a styled tip on hover (after ~300 ms) and on keyboard focus,
// including disabled buttons (their wrapper carries the tip). Read-only with the shared write guard; nothing is clicked.
// BAU_LOCAL_PAGE=1 serves the local bau-workflow.html / bau-progress.js in place of production (API still production).
// Run: MC_AGENT_PASSWORD=… MC_BASE_URL=https://apps-dashboard-lilac.vercel.app EVIDENCE_DIR=… npx playwright test tests/e2e/bau-tips.spec.js
import { test, expect } from '../helpers/bau-guard.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { mcBaseUrl, mcLogin } from '../helpers/mc.mjs';

const EVIDENCE = process.env.EVIDENCE_DIR || path.join(process.cwd(), 'tmp', 'bau-tips');
let session;
test.use({ channel: 'chrome', viewport: { width: 1600, height: 1000 } });
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
const tipOf = (page) => page.getByTestId('tip');
/** The element that carries the tip: the control itself, or the wrapper around a (possibly disabled) button. */
const carrier = (page, testid) => page.getByTestId(testid).locator('xpath=ancestor-or-self::*[@data-tip][1]');
async function expectTip(page, testid, text) {
  await page.mouse.move(2, 2);
  await carrier(page, testid).hover();
  await expect(tipOf(page)).toBeVisible();
  await expect(tipOf(page)).toHaveText(text);
}

test('Run panel: every control shows its tip on hover (disabled Live / Resume / Cancel too)', async ({ page }) => {
  await openPage(page);
  await expectTip(page, 'run-all-check-label', 'Run all will build and check every stage. Nothing changes on the live site or database.');
  await expectTip(page, 'run-all-live-label', "Live Run all isn't available. Run all builds and checks every stage; then publish each stage with its own Publish live… button.");
  await expectTip(page, 'include-audit-label', /^Adds stage I to Run all\. In a check the full audit is only simulated/);
  await expectTip(page, 'update-all-start', /^Builds and checks stages A–H in order .* Nothing goes live\./);
  await expectTip(page, 'update-all-resume', 'Carries on the last failed run from the step that failed.');
  await expectTip(page, 'update-all-cancel', /^Cancels a run that is still queued.*carries on to the end\.$/);
  await expectTip(page, 'open-progress', 'Opens the progress window for this run.');
  await expectTip(page, 'run-status-dismiss', 'Hides this result box on this device. The run stays in the stage history.');
});

test('stage rows A, B, I and the Steps toggle: tips on hover, with the chip times; disabled "2. Already live" too', async ({ page }) => {
  await openPage(page);
  await expectTip(page, 'stage-run-A', /^Builds this stage in a safe copy and checks it \(about \d+ (s|min)\)\. Nothing changes on the live site or database\. Then use 2\. Publish live…$/);
  await expectTip(page, 'stage-live-A', /^Publishes this stage's last checked build\. It shows you exactly what will change and asks you to confirm first \(about \d+ (s|min)\)\.$/);
  await page.screenshot({ path: path.join(EVIDENCE, 'tip-publish-live-A.png') });
  await expectTip(page, 'stage-undo-A', 'Puts back the files this stage last published live. It asks you to confirm first.');
  await expectTip(page, 'stage-live-B', /\(about 10–17 min, estimated\)\.$/);
  await expectTip(page, 'stage-undo-B', /^Restores the database tables from the backup taken before this stage's last live run, until \d+ Nov, \d\d:\d\d, and puts back the 05 file\. It asks you to confirm first\.$/);
  await page.screenshot({ path: path.join(EVIDENCE, 'tip-undo-B.png') });
  await expectTip(page, 'stage-undo-H', /and puts back the 09 keywords file\. It asks you to confirm first\.$/);
  await expectTip(page, 'stage-live-C', /^Checked build \w{8} was published live on .+\. Run 1\. Build & check to make a new one\.$/);
  await expectTip(page, 'stage-live-I', 'Starts the full site audit now. It runs in the background for about 3 hours, and the results appear in the AI GEO audit app and the Monday brief. Not available on Mondays (it runs automatically then) or while an audit is already running.');
  await expectTip(page, 'audit-open', "Opens the AI GEO audit app, where this audit's results are.");
  await page.locator('tr[data-stage="A"]').getByTestId('commit-link').first().hover();
  await expect(tipOf(page)).toHaveText('Opens this commit on GitHub, showing exactly which files changed.');
  await expectTip(page, 'steps-summary', 'Shows or hides the step-by-step log of the last run.');
});

test('keyboard focus shows the tip, also on a disabled button (its wrapper takes focus)', async ({ page }) => {
  await openPage(page);
  await page.getByTestId('update-all-start').focus();
  await expect(tipOf(page)).toHaveText(/^Builds and checks stages A–H in order/);
  await carrier(page, 'stage-live-C').focus();
  await expect(tipOf(page)).toHaveText(/Run 1\. Build & check to make a new one\.$/);
  await carrier(page, 'update-all-resume').focus();
  await expect(tipOf(page)).toHaveText('Carries on the last failed run from the step that failed.');
});

test('tip style: dark theme, max 320 px, appears after about 300 ms', async ({ page }) => {
  await openPage(page);
  await page.mouse.move(2, 2);
  await carrier(page, 'stage-live-I').hover();
  await page.waitForTimeout(120);
  await expect(tipOf(page)).toBeHidden();
  await expect(tipOf(page)).toBeVisible();
  const s = await tipOf(page).evaluate((e) => ({ w: e.getBoundingClientRect().width, bg: getComputedStyle(e).backgroundColor }));
  expect(s.w).toBeLessThanOrEqual(320);
  expect(s.bg).toBe('rgb(27, 33, 48)');
});
