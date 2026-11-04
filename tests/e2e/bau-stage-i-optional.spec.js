// BAU stage I looks optional (Alan 4 Nov 10:47): its row is a dashed (#4a5263, 8 px radius), lighter (#1b2130) box,
// inset from the table edges, about 10 px below H; rows A–H unchanged. Read-only with the shared write guard.
// BAU_LOCAL_PAGE=1 serves the local bau-workflow.html / bau-progress.js in place of production (API still production).
// Run: MC_AGENT_PASSWORD=… MC_BASE_URL=https://apps-dashboard-lilac.vercel.app EVIDENCE_DIR=… npx playwright test tests/e2e/bau-stage-i-optional.spec.js
import { test, expect } from '../helpers/bau-guard.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { mcBaseUrl, mcLogin } from '../helpers/mc.mjs';

const EVIDENCE = process.env.EVIDENCE_DIR || path.join(process.cwd(), 'tmp', 'bau-stage-i-optional');
let session;
test.use({ channel: 'chrome' });
test.beforeAll(async () => { session = await mcLogin('agent'); fs.mkdirSync(EVIDENCE, { recursive: true }); });

async function openPage(page) {
  if (process.env.BAU_LOCAL_PAGE === '1') {
    for (const f of ['bau-workflow.html', 'bau-progress.js']) {
      await page.route((u) => u.pathname === `/${f}`, (r) => r.fulfill({ body: fs.readFileSync(f, 'utf8'), contentType: f.endsWith('.js') ? 'text/javascript' : 'text/html' }));
    }
  }
  await page.addInitScript((s) => { sessionStorage.setItem('mc_session_token', s.token); sessionStorage.setItem('mc_session_role', s.role); }, session);
  await page.goto(`${mcBaseUrl()}/bau-workflow.html`);
  await expect(page.getByTestId('stage-run-A')).toBeVisible({ timeout: 30000 });
}
const boxStyle = (page) => page.getByTestId('optional-box').evaluate((e) => {
  const s = getComputedStyle(e); const r = e.getBoundingClientRect(); const t = e.closest('table').getBoundingClientRect();
  const h = document.querySelector('tr[data-stage="H"]').getBoundingClientRect();
  return { sides: ['Top', 'Right', 'Bottom', 'Left'].map((k) => `${s[`border${k}Style`]} ${s[`border${k}Width`]} ${s[`border${k}Color`]}`),
    radius: s.borderTopLeftRadius, bg: s.backgroundColor, insetL: r.left - t.left, insetR: t.right - r.right, gapAboveH: r.top - h.bottom };
});
const rowStyles = (page) => page.locator('#stageRows tr:not([data-stage="I"]) td').evaluateAll((tds) => [...new Set(tds.map((td) => {
  const s = getComputedStyle(td); return `${s.backgroundColor} | ${s.borderTopStyle} ${s.borderTopWidth} ${s.borderTopColor}`;
}))]);

/** Rows G, H and I, cropped from a full-page screenshot (page coordinates). */
async function shotGHI(page, name) {
  const clip = await page.evaluate(() => {
    const g = document.querySelector('tr[data-stage="G"]').getBoundingClientRect();
    const i = document.querySelector('tr[data-stage="I"]').getBoundingClientRect();
    return { x: 0, y: Math.max(0, g.top + scrollY - 4), width: document.documentElement.clientWidth, height: i.bottom - g.top + 8 };
  });
  await page.screenshot({ path: path.join(EVIDENCE, `stage-rows-ghi-${name}.png`), clip, fullPage: true });
}

for (const [name, viewport] of [['1920', { width: 1920, height: 1200 }], ['phone', { width: 390, height: 844 }]]) {
  test(`stage I is a dashed, lighter, inset box below H; rows A–H unchanged (${name})`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openPage(page);
    const b = await boxStyle(page);
    for (const side of b.sides) expect(side).toBe('dashed 1px rgb(74, 82, 99)');
    expect(b.radius).toBe('8px');
    expect(b.bg).toBe('rgb(27, 33, 48)');
    expect(b.insetL).toBeGreaterThanOrEqual(3);
    expect(b.insetR).toBeGreaterThanOrEqual(3);
    expect(b.gapAboveH).toBeGreaterThanOrEqual(8);
    const rows = await rowStyles(page);
    expect(rows.every((r) => r.startsWith('rgba(0, 0, 0, 0)'))).toBe(true);
    expect(rows.some((r) => r.includes('rgb(27, 33, 48)'))).toBe(false);
    if (name === '1920') expect(rows).toEqual(['rgba(0, 0, 0, 0) | solid 1px rgb(38, 45, 58)']);
    await expect(page.locator('tr[data-stage="I"] [data-label="Last runs"] [data-testid="audit-status"]')).toBeVisible();
    await expect(page.getByTestId('stage-live-I')).toHaveText('Start full audit ①…');
    await shotGHI(page, name);
  });
}
