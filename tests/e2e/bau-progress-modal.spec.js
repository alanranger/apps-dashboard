// BAU progress window (Alan 3 Nov): a simulated single-stage live B and a simulated Run all, queued → running (bar moves,
// ETA shows, log grows) → finished, plus a stalled heartbeat (amber after 60 s, red after 3 min). Read-only: only the page's
// GET of the latest run is replaced (route); nothing is posted and no stage runs.
// Run: MC_AGENT_PASSWORD=… MC_BASE_URL=https://apps-dashboard-lilac.vercel.app EVIDENCE_DIR=… npx playwright test tests/e2e/bau-progress-modal.spec.js
import { test, expect } from '../helpers/bau-guard.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { mcBaseUrl, mcLogin } from '../helpers/mc.mjs';

const EVIDENCE = process.env.EVIDENCE_DIR || path.join(process.cwd(), 'tmp', 'bau-progress-modal');
let session;
test.use({ channel: 'chrome', viewport: { width: 1280, height: 1000 } });
test.beforeAll(async () => { session = await mcLogin('agent'); fs.mkdirSync(EVIDENCE, { recursive: true }); });

const at = (s) => new Date(Date.now() - s * 1000).toISOString();
const step = (ord, id, name, status, extra = {}) => ({ ord, step_id: id, name, status, ...extra });
const log = (...lines) => lines.map(([s, text]) => ({ at: at(s), text }));
const EST = { preflight: 4000, ingest_preliminary: 300000, summary: 1000, build_csvs: 60000, reviews: 120000, product_schema: 90000,
  publish_products: 20000, event_posts: 90000, event_index: 20000, publish_events: 20000, blog_index: 10000, blog_posts: 120000,
  publish_blogs: 20000, landing_pages: 60000, publish_landings: 20000, final_ingest: 300000, export_09: 10000, audit: 600000 };
const runB = (extra) => ({ id: 'simulated-b000-0000', mode: 'live', stages: ['B'], options: {}, requested_at: at(90), include_audit: false, needs_alan: [], stage_results: {}, ...extra });

const B = {
  queued: () => ({ run: runB({ status: 'requested', requested_at: at(10) }), steps: [], runner: { checked_at: at(26) } }),
  running: (chunk, beat = 3) => ({ run: runB({ status: 'running', started_at: at(60), current_step: 'ingest_preliminary', heartbeat_at: at(beat),
    progress: { step: 'ingest_preliminary', label: 'Backing up page_html — chunk {n} of {total}', done: Math.max(0, chunk - 1), total: 14, at: at(beat) },
    // A stalled runner writes nothing: its log stops at the last heartbeat too.
    log: log(...[[60, 'Step 1 of 3: Pre-flight checks — started'], [56, 'Pre-flight checks — ok (4 s)'], [55, 'Step 2 of 3: Preliminary ingest (steps 1–4) + mappings export — started'],
      ...Array.from({ length: chunk }, (_, i) => [50 - i * 3, `Backing up page_html — chunk ${i + 1} of 14`])].map(([s, t]) => [Math.max(s, beat), t])) }),
  steps: [step(1, 'preflight', 'Pre-flight checks', 'ok', { duration_ms: 4000 }), step(3, 'ingest_preliminary', 'Preliminary ingest (steps 1–4) + mappings export', 'running', { started_at: at(55) }),
    step(18, 'summary', 'Summary', 'pending')] }),
  finished: () => ({ run: runB({ status: 'succeeded', started_at: at(400), finished_at: at(5), heartbeat_at: at(5),
    stage_results: { B: { status: 'ok', mode: 'live', backup_run: 'simulate', export_commit: 'deadbeefcafe', promoted_from: 'c3fd7897' } },
    log: log([400, 'Step 1 of 3: Pre-flight checks — started'], [6, 'Summary — ok (1 s)']) }),
  steps: [step(1, 'preflight', 'Pre-flight checks', 'ok'), step(3, 'ingest_preliminary', 'Preliminary ingest', 'ok'), step(18, 'summary', 'Summary', 'ok')] }),
};

const ORDER = [['preflight', 'A'], ['build_csvs', 'A'], ['ingest_preliminary', 'B'], ['reviews', 'C'], ['product_schema', 'D'], ['publish_products', 'D'], ['event_posts', 'E'],
  ['event_index', 'E'], ['publish_events', 'E'], ['blog_index', 'F'], ['blog_posts', 'F'], ['publish_blogs', 'F'], ['landing_pages', 'G'], ['publish_landings', 'G'],
  ['final_ingest', 'H'], ['export_09', 'H'], ['audit', 'I'], ['summary', null]];
const runAll = () => ({ run: { id: 'simulated-all0-0000', mode: 'dry', stages: null, options: {}, requested_at: at(400), started_at: at(390), status: 'running', current_step: 'reviews',
  include_audit: true, needs_alan: [], stage_results: {}, heartbeat_at: at(2), progress: { step: 'reviews', label: 'Matching Google reviews', done: 30, total: 60, at: at(2) },
  log: log([390, 'Step 1 of 18: Pre-flight checks — started'], [2, 'Matching Google reviews — 30 of 60']) },
steps: ORDER.map(([id], i) => step(i + 1, id, id, i < 3 ? 'ok' : i === 3 ? 'running' : 'pending', i === 3 ? { started_at: at(60) } : { duration_ms: 1000 })) });

const latestGet = (url) => url.pathname === '/api/update-all' && url.searchParams.has('run');
async function simulate(page, fake) {
  await page.unroute(latestGet).catch(() => {});
  await page.route(latestGet, async (route) => {
    const real = await (await route.fetch()).json();
    await route.fulfill({ json: { ...real, estimates: EST, runner: null, ...fake(), server_now: new Date().toISOString() } });
  });
}
async function openPage(page) {
  await page.addInitScript((s) => { sessionStorage.setItem('mc_session_token', s.token); sessionStorage.setItem('mc_session_role', s.role); }, session);
  await page.goto(`${mcBaseUrl()}/bau-workflow.html`);
  await expect(page.getByTestId('stage-run-A')).toBeVisible({ timeout: 30000 });
}
const shot = (page, name) => page.screenshot({ path: path.join(EVIDENCE, `${name}.png`) });
const modal = (page) => page.locator('#pgModal');

test('single stage (live B): queued → running (bar moves, ETA, log grows) → finished, tab title', async ({ page }) => {
  await simulate(page, B.queued);
  await openPage(page);
  await page.getByTestId('open-progress').click();
  await expect(modal(page).getByTestId('pg-queued')).toContainText(/next check in \d+ s/);
  await expect(modal(page).getByTestId('pg-title')).toContainText('Stage B');
  await shot(page, '1-single-queued');

  await simulate(page, () => B.running(9));
  await expect(modal(page).getByTestId('pg-sub')).toContainText('Backing up page_html — chunk 9 of 14', { timeout: 10000 });
  const pct1 = Number(await modal(page).getByTestId('pg-bar').getAttribute('data-pct'));
  await expect(modal(page).getByTestId('pg-eta')).toContainText(/min left|under a minute/);
  await expect(modal(page).getByTestId('pg-alive')).toHaveAttribute('data-level', 'ok');
  const lines1 = await modal(page).locator('#pgLog li').count();
  await expect(page.getByTestId('pg-row-B')).toBeVisible();
  await shot(page, '2-single-running');

  await simulate(page, () => B.running(14));
  await expect(modal(page).getByTestId('pg-sub')).toContainText('chunk 14 of 14', { timeout: 10000 });
  const pct2 = Number(await modal(page).getByTestId('pg-bar').getAttribute('data-pct'));
  expect(pct2).toBeGreaterThan(pct1);
  expect(await modal(page).locator('#pgLog li').count()).toBeGreaterThan(lines1);

  await simulate(page, B.finished);
  await expect(modal(page).getByTestId('pg-result')).toContainText('Published live', { timeout: 10000 });
  await expect(modal(page)).toContainText('bau_bk_simulate_*');
  await expect(page).toHaveTitle(/✅ B done — BAU/);
  await shot(page, '3-single-finished');
});

test('stalled: no heartbeat for 60 s turns amber, 3 min turns red with what to do', async ({ page }) => {
  await simulate(page, () => B.running(9, 75));
  await openPage(page);
  await page.getByTestId('open-progress').click();
  await expect(modal(page).getByTestId('pg-alive')).toHaveAttribute('data-level', 'amber');
  await expect(modal(page).getByTestId('pg-alive')).toContainText('still working?');
  await shot(page, '4-stalled-amber');
  await simulate(page, () => B.running(9, 200));
  await expect(modal(page).getByTestId('pg-alive')).toHaveAttribute('data-level', 'red', { timeout: 10000 });
  await expect(modal(page).getByTestId('pg-alive')).toContainText('Runner seems stopped');
  await shot(page, '5-stalled-red');
});

test('no sub-progress and past the usual time: says "longer than usual", never "under a minute left"', async ({ page }) => {
  const slow = () => { const d = B.running(0); delete d.run.progress; d.steps[1].started_at = at(1400); return d; };
  await simulate(page, slow);
  await openPage(page);
  await page.getByTestId('open-progress').click();
  await expect(modal(page).getByTestId('pg-eta')).toContainText('taking longer than usual');
  await expect(modal(page).getByTestId('pg-eta')).not.toContainText('under a minute');
  await expect(modal(page).getByTestId('pg-bar')).toHaveAttribute('data-pct', '');
  await expect(modal(page).getByTestId('pg-bar')).toContainText('no % yet');
});

test('Run all: overall stage x of 9 with %, current stage bar and the per-stage tick list', async ({ page }) => {
  await simulate(page, runAll);
  await openPage(page);
  await page.getByTestId('open-progress').click();
  await expect(modal(page).getByTestId('pg-overall')).toContainText('stage 3 of 9');
  await expect(modal(page).getByTestId('pg-bar-overall')).toBeVisible();
  await expect(modal(page).locator('[data-testid="pg-stages"] li[data-stage="A"]')).toHaveAttribute('data-status', 'ok');
  await expect(modal(page).locator('[data-testid="pg-stages"] li[data-stage="C"]')).toHaveAttribute('data-status', 'running');
  await expect(modal(page).locator('[data-testid="pg-stages"] li[data-stage="I"]')).toHaveAttribute('data-status', 'pending');
  await expect(modal(page).getByTestId('pg-sub')).toContainText('Matching Google reviews — 30 of 60');
  await shot(page, '6-run-all-running');
});
