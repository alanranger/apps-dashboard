import test from 'node:test';
import assert from 'node:assert/strict';
import { retentionPlan, decideBackup, undoUntil, applyRetention } from '../../runner/bau-retention.mjs';

const DAY = 86400000;
const NOW = Date.parse('2026-11-20T12:00:00Z');
const iso = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();
const run = (id, stage, status, daysAgo, extra = {}) => ({ id: `${id}-0000-0000`, mode: 'live', stages: [stage], status, requested_at: iso(daysAgo), finished_at: status === 'running' ? null : iso(daysAgo), options: {}, ...extra });
const inv = (run8, mb = 350) => [{ table_name: `bau_bk_${run8}_page_html`, run8, kind: 'backup', bytes: mb * 1048576 }, { table_name: `bau_bk_${run8}_urls`, run8, kind: 'backup', bytes: 0 }];

test('retention: kept inside the 14-day undo window, dropped after it', () => {
  const runs = [run('aaaaaaaa', 'B', 'succeeded', 13)];
  assert.equal(decideBackup('aaaaaaaa', inv('aaaaaaaa'), runs, NOW).action, 'keep');
  assert.match(decideBackup('aaaaaaaa', inv('aaaaaaaa'), runs, NOW).reason, /until/);
  const old = [run('aaaaaaaa', 'B', 'succeeded', 15)];
  const d = decideBackup('aaaaaaaa', inv('aaaaaaaa'), old, NOW);
  assert.equal(d.action, 'drop');
  assert.match(d.reason, /undo window ended/);
  assert.equal(undoUntil({ finished_at: '2026-11-03T17:00:00Z' }), '2026-11-17T17:00:00.000Z');
});

test('retention: superseded by a newer succeeded live run of the same stage (only the latest is kept)', () => {
  const runs = [run('bbbbbbbb', 'B', 'succeeded', 2), run('aaaaaaaa', 'B', 'succeeded', 5), run('cccccccc', 'H', 'succeeded', 1)];
  const plan = retentionPlan([...inv('aaaaaaaa'), ...inv('bbbbbbbb'), ...inv('cccccccc')], runs, NOW);
  const by = Object.fromEntries(plan.map((p) => [p.run8, p]));
  assert.equal(by.aaaaaaaa.action, 'drop');
  assert.match(by.aaaaaaaa.reason, /superseded by live run bbbbbbbb/);
  assert.equal(by.bbbbbbbb.action, 'keep');
  assert.equal(by.cccccccc.action, 'keep', 'a newer H run does not supersede B');
});

test('retention: never while the stage is mid-undo or the run failed awaiting retry (even past 14 days)', () => {
  const undo = { ...run('dddddddd', 'B', 'running', 0), options: { undo_of: 'aaaaaaaa-0000-0000' } };
  assert.equal(decideBackup('aaaaaaaa', inv('aaaaaaaa'), [undo, run('aaaaaaaa', 'B', 'succeeded', 20)], NOW).reason, 'stage is mid-undo');
  const failed = decideBackup('aaaaaaaa', inv('aaaaaaaa'), [run('aaaaaaaa', 'B', 'failed', 20)], NOW);
  assert.equal(failed.action, 'keep');
  assert.match(failed.reason, /awaiting retry/);
  assert.equal(decideBackup('aaaaaaaa', inv('aaaaaaaa'), [run('aaaaaaaa', 'B', 'running', 0)], NOW).action, 'keep');
  assert.equal(decideBackup('eeeeeeee', inv('eeeeeeee'), [], NOW).action, 'keep', 'unknown run: kept, checked by hand');
  const resolved = decideBackup('aaaaaaaa', inv('aaaaaaaa'), [run('bbbbbbbb', 'B', 'succeeded', 1), run('aaaaaaaa', 'B', 'failed', 20)], NOW);
  assert.equal(resolved.action, 'drop', 'a failed run is resolved once a newer live run of its stage succeeded');
});

test('retention: proof tables always go; drops only name bau_bk tables and are logged', async () => {
  const plan = retentionPlan([{ table_name: 'bau_bk_test2_c3fd7897_urls', run8: null, kind: 'test', bytes: 10 }], [], NOW);
  assert.equal(plan[0].action, 'drop');
  const calls = [];
  const lines = await applyRetention([...plan, { run8: 'aaaaaaaa', tables: ['bau_bk_aaaaaaaa_page_html'], bytes: 350 * 1048576, action: 'drop', reason: 'undo window ended 2026-11-17' },
    { run8: 'bbbbbbbb', tables: ['bau_bk_bbbbbbbb_page_html'], bytes: 1, action: 'keep', reason: 'x' }], async (fn, a) => { calls.push(a.p_table); return true; });
  assert.deepEqual(calls, ['bau_bk_test2_c3fd7897_urls', 'bau_bk_aaaaaaaa_page_html']);
  assert.equal(lines.length, 2);
  assert.match(lines[1], /350 MB/);
});
