// BAU Monthly batch 8: held Google reviews are actionable under Needs Alan. A stage C dry run (page button) with 4
// simulated held reviews; Playwright clicks Accept / Choose another / Business-level / Exclude (one each), asserts the
// saved rows are exactly those 4 ("these rows changed and no others"), then removes the test rows. The real held
// review is shown but never clicked (Alan decides it).
// Run: MC_AGENT_PASSWORD=… MC_BASE_URL=https://apps-dashboard-lilac.vercel.app EVIDENCE_DIR=… npx playwright test tests/e2e/bau-held-reviews.spec.js
import { test, expect, nodeWrite } from '../helpers/bau-guard.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { mcBaseUrl, mcLogin } from '../helpers/mc.mjs';

const EVIDENCE = process.env.EVIDENCE_DIR || path.join(process.cwd(), 'tmp', 'bau-held');
const FINISHED = ['succeeded', 'warned', 'failed', 'cancelled'];
test.use({ channel: 'chrome' });
test.describe.configure({ timeout: 60 * 60 * 1000 });

let token;
const api = async (q) => (await fetch(`${mcBaseUrl()}/api/update-all${q}`, { headers: { 'x-mc-token': token } })).json();
const post = async (body) => nodeWrite(`POST /api/update-all ${body.action}`);

test('held reviews: first name, date, stars, text, why held, suggestion; each button saves exactly its row', async ({ page }) => {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  ({ token } = await mcLogin('agent'));
  await page.addInitScript((t) => { sessionStorage.setItem('mc_session_token', t); sessionStorage.setItem('mc_session_role', 'agent'); }, token);
  let runId = process.env.HELD_RUN_ID;
  if (!runId) {
    await page.goto(`${mcBaseUrl()}/bau-workflow.html?simulateHeld=4`);
    const before = (await api('?run=latest')).run?.id;
    await page.getByTestId('stage-run-C').click();
    await expect.poll(async () => { const r = (await api('?run=latest')).run; return r && r.id !== before ? r.status : null; }, { timeout: 60000 }).toBe('requested');
    runId = (await api('?run=latest')).run.id;
    await expect.poll(async () => FINISHED.includes((await api(`?run=${runId}`)).run?.status), { timeout: 40 * 60 * 1000, intervals: [30000] }).toBe(true);
  }
  const data = await api(`?run=${runId}`);
  fs.writeFileSync(path.join(EVIDENCE, 'held-run.json'), JSON.stringify({ run: { id: data.run.id, stages: data.run.stages, status: data.run.status, needs_alan: data.run.needs_alan } }, null, 2));
  const held = (data.run.needs_alan || []).filter((n) => n.kind === 'held_review');
  const sim = held.filter((n) => n.simulated);
  expect(sim).toHaveLength(4);
  for (const n of held) expect(Object.keys(n).sort()).toEqual(['alternatives', 'count', 'date', 'file', 'first_name', 'key', 'kind', 'rating', 'suggested', 'text', 'why', ...(n.simulated ? ['simulated'] : [])].sort());

  await post({ action: 'review_choice_clear_test' });
  const before = (await api('?review_choices=1')).choices;
  await page.goto(`${mcBaseUrl()}/bau-workflow.html?run=${runId}`);
  const card = (n) => page.locator(`li.held[data-key="${n.key}"]`);
  for (const n of held) {
    await expect(card(n).getByTestId('held-name')).toHaveText(n.first_name);
    await expect(card(n).getByTestId('review-text')).toContainText(n.text.slice(0, 40));
    await expect(card(n).getByTestId('held-why')).toContainText('Why held:');
  }
  await page.screenshot({ path: path.join(EVIDENCE, 'needs-alan-held-reviews.png'), fullPage: true });
  const products = data.steps.find((s) => s.step_id === 'reviews').counts.products_for_choice;
  const other = products.find((p) => p.slug !== sim[1].suggested);

  await card(sim[0]).getByTestId('held-accept').click();
  await card(sim[1]).getByTestId('held-search').fill(other.name);
  await card(sim[1]).getByTestId('held-choose').click();
  await card(sim[2]).getByTestId('held-business').click();
  await card(sim[3]).getByTestId('held-reason').fill('test: about a print');
  await card(sim[3]).getByTestId('held-exclude').click();
  for (const n of sim) {
    await expect(card(n).getByTestId('held-saved')).toBeVisible({ timeout: 20000 });
    await expect(card(n).getByTestId('held-accept')).toBeDisabled();
  }
  await page.screenshot({ path: path.join(EVIDENCE, 'needs-alan-held-reviews-saved.png'), fullPage: true });

  const after = (await api('?review_choices=1')).choices;
  const added = after.filter((r) => !before.some((b) => b.review_key === r.review_key));
  const expected = [
    { review_key: sim[0].key, choice: 'product', product_slug: sim[0].suggested, reason: null },
    { review_key: sim[1].key, choice: 'product', product_slug: other.slug, reason: null },
    { review_key: sim[2].key, choice: 'business_level', product_slug: null, reason: null },
    { review_key: sim[3].key, choice: 'exclude', product_slug: null, reason: 'test: about a print' }];
  expect(added.map(({ review_key, choice, product_slug, reason }) => ({ review_key, choice, product_slug, reason })).sort((a, b) => a.review_key.localeCompare(b.review_key))).toEqual(expected);
  expect(after.filter((r) => !r.review_key.startsWith('bau-test-'))).toEqual(before.filter((r) => !r.review_key.startsWith('bau-test-')));
  const real = held.filter((n) => !n.simulated);
  for (const n of real) await expect(card(n).getByTestId('held-saved')).toHaveCount(0);
  fs.writeFileSync(path.join(EVIDENCE, 'held-choices-diff.json'), JSON.stringify({ added: added.map(({ review_key, choice, product_slug, reason }) => ({ review_key, choice, product_slug, reason })), real_held_left_for_alan: real.length, other_rows_unchanged: true }, null, 2));
  expect((await post({ action: 'review_choice_clear_test' })).removed).toBe(4);
});
