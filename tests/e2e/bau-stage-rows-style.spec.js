// BAU page to the approved full-page mock-up v2 (Alan 4 Nov 09:59): Needs Alan + Summary directly under the Run panel,
// Steps collapsed at the bottom; every button in a stage group has the same size and font with numbered labels; result
// pills carry the only colour (FAIL the only red), mode tags are neutral (CHECKED grey, LIVE blue); D's 19:27 second
// publish shows REFUSED; stage I has only "Start full audit ①…" and its ① line sits in the Last runs column; B's checked
// line gives its re-read count; the Live side of the Run all switch is disabled and a forced Live Run all is refused.
// Read-only: real page and API; the forced Run all call is refused before anything is created.
// Run: MC_AGENT_PASSWORD=… MC_BASE_URL=https://apps-dashboard-lilac.vercel.app EVIDENCE_DIR=… MOCKUP=… npx playwright test tests/e2e/bau-stage-rows-style.spec.js
import { test, expect, refusedLiveRunAll } from '../helpers/bau-guard.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mcBaseUrl, mcLogin, mcApi } from '../helpers/mc.mjs';

const EVIDENCE = process.env.EVIDENCE_DIR || path.join(process.cwd(), 'tmp', 'bau-stage-rows-style');
const MOCKUP = process.env.MOCKUP || '';
let session;
test.use({ channel: 'chrome', viewport: { width: 1400, height: 1500 } });
test.beforeAll(async () => { session = await mcLogin('agent'); fs.mkdirSync(EVIDENCE, { recursive: true }); });

async function openPage(page) {
  await page.addInitScript((s) => { sessionStorage.setItem('mc_session_token', s.token); sessionStorage.setItem('mc_session_role', s.role); }, session);
  await page.goto(`${mcBaseUrl()}/bau-workflow.html`);
  await expect(page.getByTestId('stage-run-A')).toBeVisible({ timeout: 30000 });
}
const isRed = (rgb) => { const [r, g, b] = (rgb.match(/\d+/g) || []).map(Number); return r > 180 && g < 130 && b < 130; };

test('order: Needs Alan + Summary directly under the Run panel; Stages next; Steps collapsed at the bottom', async ({ page }) => {
  await openPage(page);
  const order = await page.locator('.container > *').evaluateAll((els) => els.filter((e) => getComputedStyle(e).display !== 'none').map((e) => e.id || e.className));
  expect(order).toEqual(['header', 'controlPanel', 'needsSummaryRow', 'stagesPanel', 'stepsPanel']);
  await expect(page.getByTestId('needs-alan')).toBeVisible();
  expect(await page.getByTestId('steps-details').evaluate((d) => d.open)).toBe(false);
  await expect(page.getByTestId('steps-summary')).toHaveText(/^Steps of the last run \(\d+\) ▸$/);
  await expect(page.getByTestId('bau-summary-line')).toContainText('Check every stage with one button, then publish each stage live.');
});

test('stage buttons: same width, height and font in every group; numbered labels per the mock-up', async ({ page }) => {
  await openPage(page);
  for (const id of 'ABCDEFGHI') {
    const sizes = await page.locator(`[data-testid="stage-buttons-${id}"] button`).evaluateAll((bs) => bs.map((b) => {
      const s = getComputedStyle(b); const r = b.getBoundingClientRect();
      return `${Math.round(r.width)}x${Math.round(r.height)} ${s.fontSize} ${s.fontWeight} ${s.fontFamily}`;
    }));
    expect(new Set(sizes).size, `stage ${id}: ${sizes.join(' | ')}`).toBe(1);
    expect(sizes[0]).toMatch(/^190x32 13px 600 /);
  }
  for (const id of 'ABCDEFGH') {
    await expect(page.getByTestId(`stage-run-${id}`)).toHaveText('1. Build & check');
    await expect(page.getByTestId(`stage-live-${id}`)).toHaveText(/^2\. (Publish live…|Already live|Nothing to publish)$/);
  }
  await expect(page.getByTestId('stage-undo-A')).toHaveText('Undo last live…');
  await expect(page.getByTestId('stage-live-D')).toHaveText(/^2\. (Already live|Nothing to publish)$/);
});

test('colour means result only: LIVE tags are blue (never red), FAIL is the only red tag; D 19:27 shows REFUSED', async ({ page }) => {
  await openPage(page);
  const modeColours = await page.locator('[data-testid="stages-table"] [data-testid="mode-tag"]').evaluateAll((els) => els.map((e) => [e.textContent, getComputedStyle(e).color]));
  expect(modeColours.length).toBeGreaterThan(8);
  for (const [text, colour] of modeColours) expect(isRed(colour), `${text} ${colour}`).toBe(false);
  expect(modeColours.some(([t]) => t === 'CHECKED')).toBe(true);
  const pills = await page.locator('[data-testid="stages-table"] [data-testid="result-pill"]').evaluateAll((els) => els.map((e) => [e.dataset.result, getComputedStyle(e).color]));
  for (const [result, colour] of pills) expect(isRed(colour), `${result} ${colour}`).toBe(result === 'fail');
  const refused = page.locator('tr[data-stage="D"] [data-testid="stage-history-refused"]');
  await expect(refused).toContainText('REFUSED');
  await expect(refused).toContainText('second publish of the same checked build, nothing changed');
  await expect(refused).toHaveAttribute('title', /4fb75e9f/);
  await page.locator('[data-testid="stages-table"]').screenshot({ path: path.join(EVIDENCE, 'stages-table.png') });
});

test('stage I: only "Start full audit ①…"; its ① line is in the Last runs column; B shows its re-read count', async ({ page }) => {
  await openPage(page);
  const i = page.locator('tr[data-stage="I"]');
  await expect(page.locator('[data-testid="stage-buttons-I"] button')).toHaveCount(1);
  await expect(page.getByTestId('stage-live-I')).toHaveText('Start full audit ①…');
  await expect(page.getByTestId('stage-run-I')).toHaveCount(0);
  await expect(i.getByTestId('chip-background')).toHaveText('Background ~3 h');
  await expect(i.getByTestId('stage-typical')).toContainText('also every Monday');
  const audit = i.locator('[data-label="Last runs"] [data-testid="audit-status"]');
  await expect(audit).toContainText(/① (latest|running)/);
  await expect(audit.getByTestId('audit-open')).toHaveText('open audit');
  await expect(i.locator('[data-label="Stage"] [data-testid="audit-status"]')).toHaveCount(0);
  await expect(i.getByTestId('stage-history-dry')).toContainText("simulated only (a check doesn't run the audit)");
  await expect(page.locator('tr[data-stage="B"] [data-testid="stage-history-dry"]')).toContainText(/\d+ of \d+ pages to re-read/);
});

test('Run panel: Check / Live switch (blue underline, Live disabled); a forced Live Run all is refused by the API', async ({ page }) => {
  await openPage(page);
  await expect(page.getByTestId('run-all-live')).toBeDisabled();
  await expect(page.getByTestId('run-all-live-label')).toHaveAttribute('data-tip', "Live Run all isn't available. Run all builds and checks every stage; then publish each stage with its own Publish live… button.");
  const on = await page.locator('.mode input:checked + span').evaluate((e) => [e.textContent, getComputedStyle(e).boxShadow, getComputedStyle(e).backgroundColor]);
  expect(on[0]).toBe('Check');
  expect(on[1]).toContain('rgb(110, 168, 254)');
  expect(on[2]).not.toBe('rgb(240, 165, 0)');
  await expect(page.getByTestId('run-all-live-note')).toContainText('Run all builds and checks every stage (nothing changes live)');
  const r = await refusedLiveRunAll(session.token);
  expect(r.status).toBe(400);
  expect(r.message).toContain("Live Run all isn't available");
  await page.locator('#controlPanel').screenshot({ path: path.join(EVIDENCE, 'run-panel.png') });
});

test('timing chips: no "Typical:" text; A–H one Check + one Live chip on one line; I one Background chip; B "~10–17 min est."', async ({ page }) => {
  await openPage(page);
  await expect(page.locator('body')).not.toContainText('Typical:');
  for (const id of 'ABCDEFGH') {
    const row = page.locator(`tr[data-stage="${id}"]`);
    await expect(row.getByTestId('chip-check')).toHaveCount(1);
    await expect(row.getByTestId('chip-live')).toHaveCount(1);
    const tops = await row.locator('[data-testid^="chip-"]').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
    expect(new Set(tops).size, `stage ${id} chips on one line: ${tops}`).toBe(1);
  }
  const i = page.locator('tr[data-stage="I"]');
  await expect(i.locator('[data-testid^="chip-"]')).toHaveCount(1);
  await expect(page.locator('tr[data-stage="B"]').getByTestId('chip-live')).toHaveText('Live ~10–17 min est.');
});

test('What it does: header, A first item exact, no digits except 05 / 07 / 09 and "7 CSVs"; stages sentence', async ({ page }) => {
  await openPage(page);
  await expect(page.locator('[data-testid="stages-table"] th').nth(1)).toHaveText('What it does');
  await expect(page.getByTestId('what-it-does-A').locator('li').first()).toHaveText('Safety checks: the Monday full refresh is not running, nothing else running, site up');
  const items = await page.locator('ol.does li').allTextContents();
  expect(items.length).toBe(27);
  for (const t of items) expect(t.replace(/\b0[579]\b/g, '').replace('7 CSVs', ''), t).not.toMatch(/\d/);
  await expect(page.locator('#stagesPanel > p.muted')).toContainText('Every publishing stage refuses to publish anything removed without an explanation.');
});

test('Needs first: stage-letter chips; A "nothing"; H = A + one of D E F G', async ({ page }) => {
  await openPage(page);
  const a = page.locator('tr[data-stage="A"] [data-testid="needs-first"]');
  await expect(a).toHaveText('nothing');
  await expect(a).toHaveClass(/muted/);
  const h = page.locator('tr[data-stage="H"] [data-testid="needs-first"]');
  await expect(h.getByTestId('needs-chip')).toHaveText(['A', 'D', 'E', 'F', 'G']);
  await expect(h).toContainText('one of');
  await expect(page.locator('tr[data-stage="D"] [data-testid="needs-chip"]')).toHaveText(['A', 'C']);
});

/** Lines each "What it does" item takes (height / line-height), keyed "A2" etc. */
const itemLines = (page) => page.locator('ol.does li').evaluateAll((lis) => lis.map((li) => {
  const lh = parseFloat(getComputedStyle(li).lineHeight);
  const n = [...li.parentElement.children].indexOf(li) + 1;
  return [`${li.parentElement.dataset.testid.slice(-1)}${n}`, li.getBoundingClientRect().height / lh];
}));

test('column widths at 1920: every "What it does" item on one line (A2/A3 may take two); Last runs → buttons gap ≤ 40 px', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await openPage(page);
  for (const [id, lines] of await itemLines(page)) expect(lines, id).toBeLessThanOrEqual(['A2', 'A3'].includes(id) ? 2.6 : 1.6);
  const gaps = await page.locator('#stageRows tr').evaluateAll((rows) => rows.map((tr) => {
    const runs = tr.querySelector('[data-label="Last runs"]');
    const right = runs.getBoundingClientRect().right - parseFloat(getComputedStyle(runs).paddingRight);
    return Math.round(tr.querySelector('.btns').getBoundingClientRect().left - right);
  }));
  for (const g of gaps) expect(g).toBeLessThanOrEqual(40);
  const cut = await page.locator('#stageRows .hline').evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth).map((e) => e.textContent));
  expect(cut).toEqual([]);
  await page.locator('#stagesPanel').screenshot({ path: path.join(EVIDENCE, 'stages-table-1920.png') });
});

test('column widths at 1440: no "What it does" item takes more than two lines', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openPage(page);
  for (const [id, lines] of await itemLines(page)) expect(lines, id).toBeLessThanOrEqual(2.6);
  await page.locator('#stagesPanel').screenshot({ path: path.join(EVIDENCE, 'stages-table-1440.png') });
});

test('phone 390: no horizontal scroll; each stage renders as a card', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openPage(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const displays = await page.locator('#stageRows tr').evaluateAll((rows) => rows.map((tr) => getComputedStyle(tr).display));
  expect(new Set(displays)).toEqual(new Set(['block']));
  await page.locator('#stagesPanel').screenshot({ path: path.join(EVIDENCE, 'stages-table-390.png') });
});

for (const [name, viewport] of [['desktop', { width: 1400, height: 1500 }], ['phone', { width: 390, height: 844 }]]) {
  test(`screenshots: whole page next to the mock-up (${name})`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openPage(page);
    await page.screenshot({ path: path.join(EVIDENCE, `page-${name}.png`), fullPage: true });
    if (!MOCKUP) return;
    await page.goto(pathToFileURL(MOCKUP).href);
    await page.screenshot({ path: path.join(EVIDENCE, `mockup-${name}.png`), fullPage: true });
  });
}
