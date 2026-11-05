// BAU four small fixes (Alan 5 Nov), items 1 and 2:
//  1. the Run all estimate leaves out stage I (it only starts the audit); with Include full audit ticked a separate note says so;
//  2. a stage whose newest checked build has nothing to publish (no files; B / H: no database rows) shows a grey, disabled
//     "2. Nothing to publish" with its tip, styled like "2. Already live"; files → orange Publish live…; already live → Already live.
// Read-only: only the page's GET of the latest run is replaced (route); nothing is posted and no stage runs.
// Run: MC_AGENT_PASSWORD=… MC_BASE_URL=https://apps-dashboard-lilac.vercel.app npx playwright test tests/e2e/bau-nothing-to-publish.spec.js
import { test, expect } from '../helpers/bau-guard.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { mcBaseUrl, mcLogin } from '../helpers/mc.mjs';

const EVIDENCE = process.env.EVIDENCE_DIR || path.join(process.cwd(), 'tmp', 'bau-nothing-to-publish');
let session;
test.use({ channel: 'chrome', viewport: { width: 1280, height: 1400 } });
test.beforeAll(async () => { session = await mcLogin('agent'); fs.mkdirSync(EVIDENCE, { recursive: true }); });

const latestGet = (u) => u.pathname === '/api/update-all' && u.searchParams.has('run');
const at = (s) => new Date(Date.now() - s * 1000).toISOString();
async function openPage(page) {
  await page.addInitScript((s) => { sessionStorage.setItem('mc_session_token', s.token); sessionStorage.setItem('mc_session_role', s.role); localStorage.removeItem('bau_dismissed_run'); }, session);
  await page.goto(`${mcBaseUrl()}/bau-workflow.html`);
  await expect(page.getByTestId('stage-run-A')).toBeVisible({ timeout: 30000 });
}

const dry = (id, extra) => ({ status: 'ok', mode: 'dry', run_id: `simul-${id.toLowerCase()}0-check`, finished_at: at(600), published: [], removed: [], ...extra });
function withHistory(real) {
  const h = real.stages.history;
  Object.assign(h.dry, {
    A: dry('A'), D: dry('D', { published: ['x_schema.json'] }), B: dry('B', { would_change: 3 }), H: dry('H', { would_change: 0 }),
    E: dry('E', { published: ['e_event_schema.json'] }),
  });
  h.live_done = { ...(h.live_done || {}), E: { status: 'ok', mode: 'live', run_id: 'simul-e1-live', promoted_from: 'simul-e0-check', finished_at: at(300), commit: 'abc1234def' } };
  return real;
}

test('item 2: empty checked build → disabled "2. Nothing to publish" with its tip; files / DB rows → Publish live…; already live stays', async ({ page }) => {
  await page.route(latestGet, async (route) => route.fulfill({ json: withHistory(await (await route.fetch()).json()) }));
  await openPage(page);
  for (const id of ['A', 'H']) {
    const btn = page.getByTestId(`stage-live-${id}`);
    await expect(btn, id).toHaveText('2. Nothing to publish');
    await expect(btn, id).toBeDisabled();
    await expect(btn, id).toHaveAttribute('data-nothing-to-publish', '1');
    await expect(btn.locator('xpath=..'), id).toHaveAttribute('data-tip', new RegExp(`^Check run simul-${id.toLowerCase()}0 at .+ found nothing new to publish\\.$`));
  }
  for (const id of ['B', 'D']) {
    await expect(page.getByTestId(`stage-live-${id}`), id).toHaveText('2. Publish live…');
    await expect(page.getByTestId(`stage-live-${id}`), id).toBeEnabled();
  }
  const live = page.getByTestId('stage-live-E');
  await expect(live).toHaveText('2. Already live');
  const style = (loc) => loc.evaluate((el) => { const s = getComputedStyle(el); const r = el.getBoundingClientRect(); return [el.className, s.fontSize, s.fontFamily, s.fontWeight, s.backgroundColor, Math.round(r.width), Math.round(r.height)]; });
  expect(await style(page.getByTestId('stage-live-A'))).toEqual(await style(live));
  await page.locator('[data-testid="stages-table"]').screenshot({ path: path.join(EVIDENCE, 'nothing-to-publish.png') });
});

const STEPS = [['preflight', 'A'], ['build_csvs', 'A'], ['ingest_preliminary', 'B'], ['reviews', 'C'], ['product_schema', 'D'], ['publish_products', 'D'], ['event_posts', 'E'],
  ['event_index', 'E'], ['publish_events', 'E'], ['blog_index', 'F'], ['blog_posts', 'F'], ['publish_blogs', 'F'], ['landing_pages', 'G'], ['blocks_css', 'G'], ['publish_landings', 'G'],
  ['final_ingest', 'H'], ['export_09', 'H'], ['audit', 'I'], ['summary', null]];
const EST = Object.fromEntries(STEPS.map(([id]) => [id, id === 'audit' ? 10849861 : 60000]));
const runAll = (includeAudit) => ({ run: { id: 'simulated-all0-0000', mode: 'dry', stages: null, options: {}, requested_at: at(400), started_at: at(390), status: 'running',
  current_step: 'reviews', include_audit: includeAudit, needs_alan: [], stage_results: {}, heartbeat_at: at(2), log: [] },
steps: STEPS.map(([id], i) => ({ ord: i + 1, step_id: id, name: id, status: i < 3 ? 'ok' : i === 3 ? 'running' : 'pending', ...(i === 3 ? { started_at: at(30) } : { duration_ms: 1000 }) })) });

for (const includeAudit of [true, false]) {
  test(`item 1: Run all estimate leaves out stage I's ~3 h (Include full audit ${includeAudit ? 'ticked' : 'not ticked'})`, async ({ page }) => {
    await page.route(latestGet, async (route) => route.fulfill({ json: { ...(await (await route.fetch()).json()), estimates: EST, runner: null, ...runAll(includeAudit), server_now: new Date().toISOString() } }));
    await openPage(page);
    await page.getByTestId('open-progress').click();
    const overall = page.locator('#pgModal').getByTestId('pg-overall');
    await expect(overall).toContainText(/about \d+ min left/);
    const mins = Number((await overall.textContent()).match(/about (\d+) min left/)[1]);
    expect(mins).toBeLessThan(30);
    const note = page.locator('#pgModal').getByTestId('pg-audit-note');
    if (includeAudit) await expect(note).toHaveText(' + full audit ① (simulated in a check; live it runs ~3 h in the background)');
    else await expect(note).toHaveText('');
    await page.locator('#pgModal').screenshot({ path: path.join(EVIDENCE, `estimate-audit-${includeAudit ? 'on' : 'off'}.png`) });
  });
}
