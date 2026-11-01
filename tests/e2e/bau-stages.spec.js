// BAU Monthly per-stage buttons (batch 7), all DRY, page buttons only — the Windows task AlanUpdateAllRunner picks
// each run up. 1) prerequisites missing → "Run A and B first" + "Run A, B, then E"; 2) each stage A–H alone: only that
// stage's steps run and each publish step lists only its own kind of file; 3) the 08 Service / Landing / Exclude buttons
// on simulated new pages (stage A): the saved choices are exactly those rows; 4) readability: expected changes are Info,
// summary counts = per-level counts, Details collapsed, no horizontal scroll at 1920 / 390 px. Screenshots → EVIDENCE_DIR.
// Run: MC_AGENT_PASSWORD=… MC_BASE_URL=https://apps-dashboard-lilac.vercel.app EVIDENCE_DIR=… npx playwright test tests/e2e/bau-stages.spec.js
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import stages from '../../runner/stages.cjs';
import { mcBaseUrl, mcLogin } from '../helpers/mc.mjs';

const { stepsFor } = stages;
const EVIDENCE = process.env.EVIDENCE_DIR || path.join(process.cwd(), 'tmp', 'bau-stages');
const FINISHED = ['succeeded', 'warned', 'failed', 'cancelled'];
const SIMULATED = ['https://www.alanranger.com/bau-test-simulated-photography-course-1', 'https://www.alanranger.com/bau-test-simulated-landing-2',
  'https://www.alanranger.com/bau-test-simulated-page-3'];
const STAGES = (process.env.STAGES || 'A,B,C,D,E,F,G,H').split(',');

/** Each publish step may only list its own kind of file. */
const PUBLISH_KIND = {
  publish_products: /^(?!.*(_event_schema|_blogposting|_breadcrumb|_image|_howto|_landing_schema)).*_(schema|faq)\.json$/,
  publish_events: /(_event_schema\.json|events-manifest\.json|^(lessons|workshops)-schema\.json|^(beginners-photography-lessons|photographic-workshops-near-me)_faq\.json)$/,
  publish_blogs: /(^blog-schema\.json|_(schema|blogposting|breadcrumb|image|faq|howto)\.json)$/,
  publish_landings: /(_landing_schema\.json|landings-manifest\.json)$/
};

test.use({ channel: 'chrome' });
test.describe.configure({ mode: 'serial', timeout: 4 * 60 * 60 * 1000 });

let token;
const api = async (q) => (await fetch(`${mcBaseUrl()}/api/update-all${q}`, { headers: { 'x-mc-token': token } })).json();
const latest = () => api('?run=latest');

async function openPage(page, query = '') {
  await page.addInitScript((t) => { sessionStorage.setItem('mc_session_token', t); sessionStorage.setItem('mc_session_role', 'agent'); }, token);
  await page.goto(`${mcBaseUrl()}/bau-workflow.html${query}`);
  await expect(page.getByTestId('stage-run-A')).toBeVisible({ timeout: 30000 });
}

/** Click a stage button, wait for the scheduled runner to pick the run up and finish it. */
async function runStage(page, stage) {
  const before = (await latest()).run?.id;
  await page.getByTestId(`stage-run-${stage}`).click();
  await expect.poll(async () => { const r = (await latest()).run; return r && r.id !== before ? r.status : null; }, { timeout: 60000 }).toBe('requested');
  const runId = (await latest()).run.id;
  await expect.poll(async () => FINISHED.includes((await latest()).run?.status), { timeout: 60 * 60 * 1000, intervals: [30000] }).toBe(true);
  const data = await latest();
  expect(data.run.id).toBe(runId);
  fs.writeFileSync(path.join(EVIDENCE, `stage-${stage}-run.json`), JSON.stringify(data, null, 2));
  return data;
}

async function assertReadable(page, data, name) {
  await page.reload();
  await expect(page.getByTestId('run-id')).toHaveText(data.run.id.slice(0, 8));
  const counts = { info: 0, check: 0, problem: 0 };
  for (const s of data.steps) for (const n of s.notes || []) counts[n.level] += 1;
  for (const level of Object.keys(counts)) {
    await expect(page.locator('#stepRows').getByTestId(`note-${level}`)).toHaveCount(counts[level]);
    await expect(page.getByTestId(`summary-${level}-count`).locator('strong')).toHaveText(String(counts[level]));
  }
  expect(data.run.summary.levels).toEqual(counts);
  const details = page.getByTestId('step-details');
  for (let i = 0; i < await details.count(); i += 1) expect(await details.nth(i).evaluate((d) => d.open)).toBe(false);
  await page.screenshot({ path: path.join(EVIDENCE, `${name}.png`), fullPage: true });
}

test.beforeAll(async () => {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  ({ token } = await mcLogin('agent'));
});

test('prerequisites missing: the page says "Run A and B first" and offers "Run A, B, then E" (nothing is started)', async ({ page }) => {
  test.skip(process.env.SKIP_PREREQ === '1', 'history already has A and B');
  await openPage(page);
  const before = (await latest()).run?.id;
  await page.getByTestId('stage-run-E').click();
  await expect(page.getByTestId('prereq-msg')).toHaveText('Stage E: Run A and B first.');
  await expect(page.getByTestId('prereq-chain')).toHaveText('Run A, B, then E');
  expect((await latest()).run?.id).toBe(before);
  await page.screenshot({ path: path.join(EVIDENCE, 'prereq-missing.png'), fullPage: true });
});

for (const stage of STAGES) {
  test(`stage ${stage} alone (dry, from its button): only its steps run; publish lists only its own files`, async ({ page }) => {
    await openPage(page, stage === 'A' ? `?simulate08=${SIMULATED.join(',')}` : '');
    const data = await runStage(page, stage);
    expect(data.run.stages).toEqual([stage]);
    expect(['succeeded', 'warned']).toContain(data.run.status);
    expect(data.steps.map((s) => s.step_id)).toEqual(stepsFor([stage]));
    expect(data.steps.filter((s) => s.status === 'fail')).toEqual([]);
    expect(data.run.stage_results[stage].mode).toBe('dry');
    for (const s of data.steps.filter((x) => PUBLISH_KIND[x.step_id])) {
      const files = [...(s.counts.files || []), ...(s.counts.removed || [])];
      expect(files.filter((f) => !PUBLISH_KIND[s.step_id].test(f)), `${s.step_id} lists another stage's files`).toEqual([]);
      expect(data.run.stage_results[stage].published).toEqual(s.counts.files || []);
    }
    if (stage === 'F') {
      const blog = data.steps.find((s) => s.step_id === 'blog_posts');
      await page.reload();
      const row = page.locator('tr[data-step="blog_posts"]');
      await expect(row.getByTestId('note-info').first()).toContainText('changed on the site since last month');
      await expect(row.getByTestId('note-check')).toHaveCount(0);
      expect(blog.status).toBe('ok');
    }
    await assertReadable(page, data, `stage-${stage}`);
  });
}

test('08 buttons: each simulated new page has a suggested tag and Service / Landing / Exclude; the saved choices are exactly those rows', async ({ page }) => {
  test.skip(!STAGES.includes('A'), 'needs the stage A run with simulated pages');
  const runs = await api('?runs=20');
  const runA = runs.runs.find((r) => (r.stages || []).join('') === 'A');
  const data = await api(`?run=${runA.id}`);
  const items = (data.run.needs_alan || []).filter((n) => n.kind === 'new_08_page');
  expect(items.map((n) => n.url)).toEqual(SIMULATED);
  await fetch(`${mcBaseUrl()}/api/update-all`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-mc-token': token }, body: JSON.stringify({ action: 'page_choice_clear_test' }) });
  const before = (await api('?page_choices=1')).choices;
  await openPage(page, `?run=${runA.id}`);
  const picks = { [SIMULATED[0]]: 'service', [SIMULATED[1]]: 'landing', [SIMULATED[2]]: 'exclude' };
  for (const [url, choice] of Object.entries(picks)) {
    const li = page.locator(`li[data-kind="new_08_page"][data-url="${url}"]`);
    await expect(li.getByTestId('suggested')).toBeVisible();
    await li.getByTestId(`choice-${choice}`).click();
    await expect(li.getByTestId('choice-saved')).toHaveText(`Saved: ${choice}`, { timeout: 20000 });
    await expect(li.getByTestId('choice-service')).toBeDisabled();
  }
  await page.screenshot({ path: path.join(EVIDENCE, '08-buttons-saved.png'), fullPage: true });
  const after = (await api('?page_choices=1')).choices;
  const key = (r) => `${r.url}|${r.choice}`;
  const added = after.filter((r) => !before.some((b) => key(b) === key(r)));
  expect(added.map((r) => [r.url, r.choice]).sort()).toEqual(Object.entries(picks).sort());
  expect(after.filter((r) => !SIMULATED.includes(r.url))).toEqual(before.filter((r) => !SIMULATED.includes(r.url)));
  fs.writeFileSync(path.join(EVIDENCE, '08-choices-diff.json'), JSON.stringify({ added: added.map((r) => ({ url: r.url, choice: r.choice, suggested: r.suggested })), other_rows_unchanged: after.length - added.length }, null, 2));
  const clear = await fetch(`${mcBaseUrl()}/api/update-all`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-mc-token': token }, body: JSON.stringify({ action: 'page_choice_clear_test' }) }).then((r) => r.json());
  expect(clear.removed).toBe(3);
});

test('page width: fluid up to 1800px; no horizontal scroll at 1920 and 390 px', async ({ page }) => {
  await openPage(page);
  for (const [w, h] of [[1920, 1080], [390, 844]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(800);
    const m = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth, container: document.querySelector('.container').getBoundingClientRect().width }));
    expect(m.scroll, `horizontal scroll at ${w}px`).toBeLessThanOrEqual(m.client);
    if (w === 1920) expect(m.container).toBeGreaterThan(1700);
    await page.screenshot({ path: path.join(EVIDENCE, `width-${w}.png`), fullPage: true });
  }
});
