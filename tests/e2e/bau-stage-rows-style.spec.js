// BAU page restyle to the approved mock-up (Alan 4 Nov): every button in a stage group has the same size and font; result
// pills carry the only colour (FAIL the only red), mode tags are neutral (CHECKED grey, LIVE blue — never red); D's
// 19:27 second publish shows REFUSED; the Live option of Run all is disabled and a forced Live Run all is refused.
// Read-only: real page and API; the forced Run all call is refused before anything is created.
// Run: MC_AGENT_PASSWORD=… MC_BASE_URL=https://apps-dashboard-lilac.vercel.app EVIDENCE_DIR=… npx playwright test tests/e2e/bau-stage-rows-style.spec.js
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { mcBaseUrl, mcLogin, mcApi } from '../helpers/mc.mjs';

const EVIDENCE = process.env.EVIDENCE_DIR || path.join(process.cwd(), 'tmp', 'bau-stage-rows-style');
let session;
test.use({ channel: 'chrome', viewport: { width: 1400, height: 1500 } });
test.beforeAll(async () => { session = await mcLogin('agent'); fs.mkdirSync(EVIDENCE, { recursive: true }); });

async function openPage(page) {
  await page.addInitScript((s) => { sessionStorage.setItem('mc_session_token', s.token); sessionStorage.setItem('mc_session_role', s.role); }, session);
  await page.goto(`${mcBaseUrl()}/bau-workflow.html`);
  await expect(page.getByTestId('stage-run-A')).toBeVisible({ timeout: 30000 });
}
const isRed = (rgb) => { const [r, g, b] = (rgb.match(/\d+/g) || []).map(Number); return r > 180 && g < 130 && b < 130; };

test('stage buttons: same width, height and font in every group; labels per the mock-up', async ({ page }) => {
  await openPage(page);
  for (const id of 'ABCDEFGHI') {
    const sizes = await page.locator(`[data-testid="stage-buttons-${id}"] button`).evaluateAll((bs) => bs.map((b) => {
      const s = getComputedStyle(b); const r = b.getBoundingClientRect();
      return `${Math.round(r.width)}x${Math.round(r.height)} ${s.fontSize} ${s.fontWeight} ${s.fontFamily}`;
    }));
    expect(new Set(sizes).size, `stage ${id}: ${sizes.join(' | ')}`).toBe(1);
    expect(sizes[0]).toMatch(/^190x32 13px 600 /);
  }
  await expect(page.getByTestId('stage-run-A')).toHaveText('Build & check');
  await expect(page.getByTestId('stage-undo-A')).toHaveText('Undo last live…');
  await expect(page.getByTestId('stage-live-D')).toHaveText('Already live');
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
  await expect(refused).toContainText('4fb75e9f');
  await page.locator('[data-testid="stages-table"]').screenshot({ path: path.join(EVIDENCE, 'stages-table.png') });
});

test('Run panel: Check / Live switch with Live disabled; a forced Live Run all is refused by the API', async ({ page }) => {
  await openPage(page);
  await expect(page.getByTestId('run-all-live')).toBeDisabled();
  await expect(page.locator('.run-all-mode')).toContainText('Check');
  await expect(page.getByTestId('run-all-live-note')).toContainText("Live Run all isn't available");
  const r = await mcApi('/api/update-all', { token: session.token, method: 'POST', body: { action: 'start', mode: 'live' } }).catch((e) => e);
  expect(r.status).toBe(400);
  expect(r.message).toContain("Live Run all isn't available");
  await page.locator('#controlPanel').screenshot({ path: path.join(EVIDENCE, 'run-panel.png') });
});
