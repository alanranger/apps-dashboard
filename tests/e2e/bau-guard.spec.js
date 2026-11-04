// Proof of the production-test guard (Alan 4 Nov): with the shared fixture (tests/helpers/bau-guard.mjs), a click on
// "2. Publish live…" and then "Publish live" in the confirmation is blocked before the request leaves the browser, and
// no run is created; a test that tries to write fails. A harmless probe (unknown action, which the API answers 400) must
// be blocked first, so the real click is only made once the guard is shown to be in place.
// Run: MC_AGENT_PASSWORD=… MC_BASE_URL=https://apps-dashboard-lilac.vercel.app EVIDENCE_DIR=… npx playwright test tests/e2e/bau-guard.spec.js
import { test, expect } from '../helpers/bau-guard.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { mcBaseUrl, mcLogin, mcApi } from '../helpers/mc.mjs';

const EVIDENCE = process.env.EVIDENCE_DIR || path.join(process.cwd(), 'tmp', 'bau-guard');
let session;
test.use({ channel: 'chrome', viewport: { width: 1400, height: 1500 } });
test.beforeAll(async () => { session = await mcLogin('agent'); fs.mkdirSync(EVIDENCE, { recursive: true }); });

const latestRunId = async () => (await mcApi('/api/update-all?run=latest', { token: session.token })).run?.id || null;
async function openPage(page) {
  await page.addInitScript((s) => { sessionStorage.setItem('mc_session_token', s.token); sessionStorage.setItem('mc_session_role', s.role); }, session);
  await page.goto(`${mcBaseUrl()}/bau-workflow.html`);
  await expect(page.getByTestId('stage-run-A')).toBeVisible({ timeout: 30000 });
}
/** true when the probe POST reached the network (guard missing), false when the browser blocked it. */
const probe = (page) => page.evaluate(async () => {
  try { await fetch('/api/update-all', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'guard_probe' }) }); return true; } catch { return false; }
});
async function publishableStage(page) {
  for (const id of 'ABCDEFGH') {
    const b = page.getByTestId(`stage-live-${id}`);
    if ((await b.textContent()) === '2. Publish live…' && await b.isEnabled()) return id;
  }
  return null;
}

test.describe('the guard blocks a real publish click', () => {
  test.use({ expectBlockedWrites: true });
  test('"2. Publish live…" → "Publish live" is blocked in the browser; no run is created', async ({ page, blockedWrites }) => {
    await openPage(page);
    expect(await probe(page), 'the probe must be blocked before any real click').toBe(false);
    expect(blockedWrites).toHaveLength(1);
    const before = await latestRunId();
    const stage = await publishableStage(page);
    expect(stage, 'a stage showing 2. Publish live…').not.toBeNull();
    await page.getByTestId(`stage-live-${stage}`).click();
    await expect(page.getByTestId('live-confirm-title')).toContainText(`stage ${stage}`);
    await page.getByTestId('live-confirm-publish').click();
    await expect.poll(() => blockedWrites.length).toBe(2);
    expect(blockedWrites[1]).toMatchObject({ method: 'POST', path: '/api/update-all' });
    expect(JSON.parse(blockedWrites[1].body)).toMatchObject({ action: 'start', mode: 'live', stages: [stage] });
    await page.screenshot({ path: path.join(EVIDENCE, 'guard-blocked-publish-live.png') });
    fs.writeFileSync(path.join(EVIDENCE, 'guard-blocked-writes.json'), JSON.stringify(blockedWrites, null, 2));
    await page.waitForTimeout(3000);
    expect(await latestRunId()).toBe(before);
  });
});

test('a test that tries to write fails (marked expected-to-fail: the guard fails it)', async ({ page }) => {
  test.fail();
  await openPage(page);
  expect(await probe(page)).toBe(false);
});
