// Check all / Publish all buttons (Alan 14 Nov): Publish all disabled until a finished Check all;
// partial OK list when WARN/removals; never auto-publishes. Read-only route mock — no live posts.
import { test, expect } from '../helpers/bau-guard.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { mcBaseUrl, mcLogin } from '../helpers/mc.mjs';
import { publishAllPlan } from '../../runner/publish-all-plan.mjs';

const EVIDENCE = process.env.EVIDENCE_DIR || path.join(process.cwd(), 'tmp', 'bau-publish-all');
let session;
test.use({ channel: 'chrome', viewport: { width: 1280, height: 900 } });
test.beforeAll(async () => { session = await mcLogin('agent'); fs.mkdirSync(EVIDENCE, { recursive: true }); });

const ok = () => ({ status: 'ok', removals_unexplained: 0, run_id: 'dry-ok-0000' });
const allOk = Object.fromEntries('ABCDEFGH'.split('').map((id) => [id, ok()]));
const checkAll = (results) => ({
  id: 'checkall-sim-0000', mode: 'dry', stages: null, status: 'succeeded', finished_at: new Date().toISOString(), stage_results: results
});

const latestGet = (url) => url.pathname === '/api/update-all' && url.searchParams.has('run');
async function openWith(page, publish_all, live = { can_publish: true }) {
  await page.addInitScript((s) => {
    sessionStorage.setItem('mc_session_token', s.token);
    sessionStorage.setItem('mc_session_role', s.role);
  }, session);
  await page.route(latestGet, async (route) => {
    const real = await (await route.fetch()).json();
    await route.fulfill({
      json: {
        ...real,
        run: { ...(real.run || {}), status: 'succeeded', mode: 'dry', stages: null },
        live: { ...(real.live || {}), ...live },
        publish_all,
        server_now: new Date().toISOString()
      }
    });
  });
  for (const f of ['bau-workflow.html']) {
    if (process.env.BAU_LOCAL_PAGE) {
      await page.route((u) => u.pathname === `/${f}`, (r) => r.fulfill({ path: f, contentType: 'text/html' }));
    }
  }
  await page.goto(`${mcBaseUrl()}/bau-workflow.html`);
  await expect(page.getByTestId('update-all-start')).toBeVisible({ timeout: 30000 });
}

test('Publish all disabled before Check all; active after all-OK; partial label with WARN+removals', async ({ page }) => {
  await openWith(page, publishAllPlan(null));
  const btn = page.getByTestId('publish-all');
  await expect(btn).toBeDisabled();
  await expect(btn).toHaveText('Publish all');
  await expect(page.getByTestId('update-all-start')).toHaveText('Check all stages');
  await page.screenshot({ path: path.join(EVIDENCE, '1-publish-all-disabled.png') });

  await openWith(page, publishAllPlan(checkAll(allOk)));
  await expect(page.getByTestId('publish-all')).toBeEnabled();
  await expect(page.getByTestId('publish-all')).toHaveText('Publish all');
  await page.screenshot({ path: path.join(EVIDENCE, '2-publish-all-ready.png') });

  const partial = publishAllPlan(checkAll({
    ...allOk,
    D: { status: 'warn', removals_unexplained: 0 },
    E: { status: 'ok', removals_unexplained: 2 }
  }));
  await openWith(page, partial);
  await expect(page.getByTestId('publish-all')).toBeEnabled();
  await expect(page.getByTestId('publish-all')).toContainText('6 of 8');
  await page.getByTestId('publish-all').click();
  await expect(page.getByTestId('publish-all-will')).toBeVisible();
  await expect(page.getByTestId('publish-all-skip')).toContainText('D');
  await expect(page.getByTestId('publish-all-skip')).toContainText('E');
  await page.screenshot({ path: path.join(EVIDENCE, '3-publish-all-partial-confirm.png') });
});

test('Publish all disabled when Check all is stale vs later live or newer repo commit', async ({ page }) => {
  const staleLive = publishAllPlan(checkAll(allOk), {
    liveDone: { E: { finished_at: new Date(Date.now() + 60000).toISOString(), promoted_from: 'dry-ok-0000' } }
  });
  await openWith(page, staleLive);
  await expect(page.getByTestId('publish-all')).toBeDisabled();
  await expect(page.locator('#publishAllWrap')).toHaveAttribute('data-tip', /Checks are out of date/);
  await page.screenshot({ path: path.join(EVIDENCE, '4-publish-all-stale-live.png') });

  const staleRepo = publishAllPlan(checkAll(allOk), {
    repoHeads: { schema: { committed_at: new Date(Date.now() + 60000).toISOString(), sha: '31ec86a8' } }
  });
  await openWith(page, staleRepo);
  await expect(page.getByTestId('publish-all')).toBeDisabled();
  await page.screenshot({ path: path.join(EVIDENCE, '5-publish-all-stale-repo.png') });
});

test.describe('Publish all moves on without a second start of the same stage', () => {
  test.use({ expectBlockedWrites: true });
  test('after stage A finishes, the next request is stage B of the same check', async ({ page, blockedWrites }) => {
    await page.addInitScript((s) => {
      sessionStorage.setItem('mc_session_token', s.token);
      sessionStorage.setItem('mc_session_role', s.role);
      sessionStorage.setItem('bau_publish_all', JSON.stringify({
        queue: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'], skip: [], index: 0, results: [],
        checkAllId: '2482245b-7a50-4962-8f54-ef459a014f2b', lastRunId: 'run-a-ok'
      }));
    }, session);
    await page.route('**/api/update-all**', async (route) => {
      const real = await (await route.fetch()).json();
      await route.fulfill({
        json: {
          ...real,
          run: {
            id: 'run-a-ok', status: 'succeeded', mode: 'live', stages: ['A'],
            stage_results: { A: { status: 'ok', commit: 'ef2bea0d9e6918c486082a3c89f076df5b932905', repo: 'alan-shared-resources' } }
          },
          live: { ...(real.live || {}), can_publish: true },
          publish_all: publishAllPlan(checkAll(allOk))
        }
      });
    });
    await page.route((u) => u.pathname === '/bau-workflow.html', (r) => r.fulfill({ path: 'bau-workflow.html', contentType: 'text/html' }));
    await page.goto(`${mcBaseUrl()}/bau-workflow.html`);
    await expect.poll(() => blockedWrites.length).toBe(1);
    const body = JSON.parse(blockedWrites[0].body);
    expect(body.action).toBe('start');
    expect(body.mode).toBe('live');
    expect(body.stages).toEqual(['B']);
    expect(body.checked_build).toBe('2482245b-7a50-4962-8f54-ef459a014f2b');
    await expect(page.getByTestId('pa-stage-A')).toHaveAttribute('data-status', 'published');
    await expect(page.getByTestId('pa-stage-B')).toHaveAttribute('data-status', 'failed');
    await expect(page.getByTestId('pa-stage-C')).toHaveAttribute('data-status', 'waiting');
    await expect(page.getByTestId('pa-overall')).toContainText('stopped at stage B');
    await page.screenshot({ path: path.join(EVIDENCE, '6-publish-all-advances-to-b.png') });
  });
});

test('a stopped Publish all does not leave the next stage publishing', async ({ page }) => {
  await page.addInitScript((s) => {
    sessionStorage.setItem('mc_session_token', s.token);
    sessionStorage.setItem('mc_session_role', s.role);
    sessionStorage.setItem('bau_publish_all', JSON.stringify({
      queue: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'], skip: [], index: 2,
      results: [
        { id: 'A', status: 'succeeded', commit: 'ef2bea0d9e6918c486082a3c89f076df5b932905' },
        { id: 'B', status: 'succeeded' }
      ],
      halted: { id: 'B', status: 'failed', error: 'Checks are out of date: run Check all stages first.' },
      checkAllId: '2482245b-7a50-4962-8f54-ef459a014f2b'
    }));
  }, session);
  await page.route('**/api/update-all**', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({ status: 500, json: { error: 'POST should not run while halted' } });
      return;
    }
    const real = await (await route.fetch()).json();
    await route.fulfill({
      json: {
        ...real,
        run: { id: 'run-b-ok', status: 'succeeded', mode: 'live', stages: ['B'], stage_results: { B: { status: 'ok' } } },
        live: { ...(real.live || {}), can_publish: true },
        publish_all: publishAllPlan(checkAll(allOk))
      }
    });
  });
  await page.route((u) => u.pathname === '/bau-workflow.html', (r) => r.fulfill({ path: 'bau-workflow.html', contentType: 'text/html' }));
  await page.goto(`${mcBaseUrl()}/bau-workflow.html`);
  await expect(page.getByTestId('pa-failed')).toContainText('Stopped at stage B');
  await expect(page.getByTestId('pa-overall')).toContainText('stopped at stage B');
  await expect(page.getByTestId('pa-stage-A')).toHaveAttribute('data-status', 'published');
  await expect(page.getByTestId('pa-stage-B')).toHaveAttribute('data-status', 'failed');
  await expect(page.getByTestId('pa-stage-C')).toHaveAttribute('data-status', 'waiting');
  await expect(page.getByTestId('pa-alive')).toHaveCount(0);
  await page.screenshot({ path: path.join(EVIDENCE, '7-publish-all-stopped-consistent.png') });
});
