// Update all (DRY RUN) end to end: click the button on bau-workflow.html, let the PC runner pick the run up,
// and assert the step states land in the database (via the API) and on the page. Then force a failure and
// prove Resume continues from the failed step.
// Run: MC_AGENT_PASSWORD=… MC_BASE_URL=https://apps-dashboard-lilac.vercel.app npx playwright test tests/e2e/update-all.spec.js
import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mcBaseUrl, mcLogin } from '../helpers/mc.mjs';

const ROOT = process.cwd(); // Playwright runs from the apps-dashboard root
const ONLY = 'preflight,deploy,summary';

function runner(args) {
  return new Promise((resolve) => {
    const child = spawn('node', ['runner/update-all-runner.mjs', ...args], { cwd: ROOT, env: { ...process.env, UPDATE_ALL_SITE_RETRIES: '1' } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });
}

async function latest(token) {
  const res = await fetch(`${mcBaseUrl()}/api/update-all?run=latest`, { headers: { 'x-mc-token': token } });
  return res.json();
}

async function openPage(page, token) {
  await page.addInitScript((t) => { sessionStorage.setItem('mc_session_token', t); sessionStorage.setItem('mc_session_role', 'agent'); }, token);
  await page.goto(`${mcBaseUrl()}/bau-workflow.html`);
  await expect(page.getByTestId('update-all-start')).toBeVisible();
}

test.describe.configure({ mode: 'serial', timeout: 600000 });
test.use({ channel: 'chrome' });

test('clicking Update all (dry) creates a run and the runner writes every step state', async ({ page }) => {
  const { token } = await mcLogin('agent');
  await openPage(page, token);
  await page.getByTestId('update-all-start').click();
  await expect.poll(async () => (await latest(token)).run?.status, { timeout: 30000 }).toBe('requested');
  const runId = (await latest(token)).run.id;
  const r = await runner(['--once', '--only', ONLY]);
  expect(r.code, r.out).toBe(0);
  const data = await latest(token);
  expect(data.run.id).toBe(runId);
  expect(['succeeded', 'warned']).toContain(data.run.status);
  expect(data.steps).toHaveLength(15);
  const byId = Object.fromEntries(data.steps.map((s) => [s.step_id, s.status]));
  expect(['ok', 'warn']).toContain(byId.preflight);
  expect(['ok', 'warn']).toContain(byId.deploy);
  expect(byId.summary).toBe('ok');
  expect(byId.reviews).toBe('skipped');
  await page.reload();
  await expect(page.locator('tr[data-step="summary"]')).toHaveAttribute('data-status', 'ok');
  await expect(page.getByTestId('run-status')).toHaveText(data.run.status);
});

test('a forced failure stops the run; Resume continues from the failed step', async ({ page }) => {
  const { token } = await mcLogin('agent');
  const failed = await runner(['--start', '--only', ONLY, '--fail-step', 'deploy']);
  expect(failed.out).toContain('finished: failed');
  let data = await latest(token);
  expect(data.run.status).toBe('failed');
  expect(data.steps.find((s) => s.step_id === 'deploy').status).toBe('fail');
  expect(data.steps.find((s) => s.step_id === 'summary').status).toBe('pending');
  await openPage(page, token);
  await expect(page.getByTestId('update-all-errors')).toBeVisible();
  await page.getByTestId('update-all-resume').click();
  await expect.poll(async () => (await latest(token)).run?.status, { timeout: 30000 }).toBe('requested');
  const resumed = await runner(['--once', '--only', ONLY]);
  expect(resumed.out).toContain('resume from deploy');
  data = await latest(token);
  expect(['succeeded', 'warned']).toContain(data.run.status);
  const deploy = data.steps.find((s) => s.step_id === 'deploy');
  expect(['ok', 'warn']).toContain(deploy.status);
  expect(deploy.attempt).toBe(2);
  expect(data.steps.find((s) => s.step_id === 'preflight').attempt).toBe(1);
  expect(data.steps.find((s) => s.step_id === 'summary').status).toBe('ok');
});
