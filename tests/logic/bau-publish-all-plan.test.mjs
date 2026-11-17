import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isCheckAllRun, latestCheckAll, publishAllPlan, stagePublishable, checkAllStale, stageCheckStale, STALE_TIP
} from '../../runner/publish-all-plan.mjs';

const ok = (extra = {}) => ({ status: 'ok', removals_unexplained: 0, run_id: 'aaaaaaaa-1111', ...extra });
const checkAll = (results, status = 'succeeded', finished_at = '2026-11-14T12:00:00Z') => ({
  id: 'checkall-0000', mode: 'dry', stages: null, status, stage_results: results, finished_at
});

test('isCheckAllRun: dry finished with stages omitted', () => {
  assert.equal(isCheckAllRun({ mode: 'dry', stages: null, status: 'succeeded' }), true);
  assert.equal(isCheckAllRun({ mode: 'dry', stages: [], status: 'warned' }), true);
  assert.equal(isCheckAllRun({ mode: 'dry', stages: ['E'], status: 'succeeded' }), false);
  assert.equal(isCheckAllRun({ mode: 'live', stages: null, status: 'succeeded' }), false);
  assert.equal(isCheckAllRun({ mode: 'dry', stages: null, status: 'running' }), false);
});

test('latestCheckAll picks the newest finished check-all', () => {
  const runs = [
    { id: '1', mode: 'dry', stages: ['E'], status: 'succeeded' },
    checkAll({ A: ok() }),
    { id: '3', mode: 'dry', stages: null, status: 'running' }
  ];
  assert.equal(latestCheckAll(runs).id, 'checkall-0000');
});

test('stagePublishable: ok only; warn/fail/removals blocked', () => {
  assert.equal(stagePublishable(ok(), 'D').ok, true);
  assert.equal(stagePublishable({ status: 'warn', removals_unexplained: 0 }, 'D').ok, false);
  assert.equal(stagePublishable({ status: 'ok', removals_unexplained: 2 }, 'E').ok, false);
  assert.equal(stagePublishable({ status: 'ok' }, 'B').ok, true); // B has no file removals
});

test('publishAllPlan: disabled with no check-all; all-OK; partial with WARN at D and removals at E', () => {
  assert.equal(publishAllPlan(null).ready, false);
  const all = Object.fromEntries('ABCDEFGH'.split('').map((id) => [id, ok()]));
  const full = publishAllPlan(checkAll(all));
  assert.equal(full.ready, true);
  assert.equal(full.label, 'Publish all');
  assert.deepEqual(full.publish, 'ABCDEFGH'.split(''));

  const partial = publishAllPlan(checkAll({
    ...all,
    D: { status: 'warn', removals_unexplained: 0 },
    E: { status: 'ok', removals_unexplained: 3 }
  }));
  assert.equal(partial.ready, true);
  assert.match(partial.label, /6 of 8/);
  assert.deepEqual(partial.publish, ['A', 'B', 'C', 'F', 'G', 'H']);
  assert.deepEqual(partial.skip.map((s) => s.id).sort(), ['D', 'E']);
});

test('checkAllStale: live publish after Check all disables Publish all', () => {
  const all = Object.fromEntries('ABCDEFGH'.split('').map((id) => [id, ok()]));
  const check = checkAll(all, 'succeeded', '2026-11-14T22:47:00Z');
  const liveDone = { E: { finished_at: '2026-11-14T23:01:00Z', promoted_from: 'aaaaaaaa-1111' } };
  const stale = checkAllStale(check, { liveDone });
  assert.equal(stale.stale, true);
  assert.equal(stale.tip, STALE_TIP);
  const plan = publishAllPlan(check, { liveDone });
  assert.equal(plan.ready, false);
  assert.equal(plan.tip, STALE_TIP);
});

test('checkAllStale: newer schema repo commit disables Publish all', () => {
  const all = Object.fromEntries('ABCDEFGH'.split('').map((id) => [id, ok()]));
  const check = checkAll(all, 'succeeded', '2026-11-14T22:47:00Z');
  const repoHeads = { schema: { committed_at: '2026-11-14T23:25:54Z', sha: '31ec86a8' }, shared: null };
  assert.equal(checkAllStale(check, { repoHeads }).stale, true);
  assert.equal(publishAllPlan(check, { repoHeads }).ready, false);
});

test('stageCheckStale: repo newer than dry check; already-live same promote is not stale', () => {
  const dry = { status: 'ok', finished_at: '2026-11-14T22:47:00Z', run_id: 'dry-1' };
  const live = { finished_at: '2026-11-14T23:01:00Z', promoted_from: 'dry-1' };
  assert.equal(stageCheckStale('E', dry, live, {}).stale, false);
  assert.equal(stageCheckStale('E', dry, live, { schema: { committed_at: '2026-11-14T23:25:54Z' } }).stale, true);
  assert.equal(stageCheckStale('E', dry, { finished_at: '2026-11-14T23:01:00Z', promoted_from: 'other' }, {}).stale, true);
});

test('stageCheckStale: this Check all’s own publish commits are not an outside change', () => {
  const dry = { status: 'ok', finished_at: '2026-11-17T11:14:13Z', run_id: '2482245b-7a50-4962-8f54-ef459a014f2b' };
  const heads = { shared: { committed_at: '2026-11-17T11:37:40Z', sha: 'ef2bea0d9e6918c486082a3c89f076df5b932905' } };
  assert.equal(stageCheckStale('C', dry, null, heads).stale, true);
  assert.equal(stageCheckStale('C', dry, null, heads, ['ef2bea0d9e6918c486082a3c89f076df5b932905']).stale, false);
  assert.equal(stageCheckStale('C', dry, null, heads, ['709143108a099e3594521896434cefdde7edaaf9']).stale, true);
  const outside = { shared: { committed_at: '2026-11-17T12:00:00Z', sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } };
  assert.equal(stageCheckStale('C', dry, null, outside, ['ef2bea0d9e6918c486082a3c89f076df5b932905']).stale, true);
});
