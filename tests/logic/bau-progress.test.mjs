import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { progressReporter, loggingStore } from '../../runner/progress.mjs';

const fakeStore = () => {
  const patches = [];
  return { patches, updateRun: async (id, p) => { patches.push(p); }, updateStep: async () => ({}), listSteps: async () => [] };
};

test('progress: heartbeat + log + sub-progress written to the run row; step start/finish become log lines', async () => {
  const store = fakeStore();
  const r = progressReporter(store, 'run-1', { heartbeatMs: 60000, minGapMs: 0 });
  await r.start();
  const reg = [{ id: 'preflight', name: 'Pre-flight checks' }, { id: 'ingest_preliminary', name: 'Preliminary ingest' }];
  const s = loggingStore(store, r, reg);
  await s.updateStep('run-1', 'ingest_preliminary', { status: 'running' });
  await r.progress('Backing up page_html — chunk {n} of {total}', 8, 14);
  await s.updateStep('run-1', 'ingest_preliminary', { status: 'ok', finished_at: 'x', duration_ms: 14000 });
  await r.stop();
  const last = store.patches[store.patches.length - 1];
  assert.ok(last.heartbeat_at, 'heartbeat on every write');
  assert.deepEqual(last.log.map((l) => l.text), ['Step 2 of 2: Preliminary ingest — started', 'Preliminary ingest — ok (14 s)']);
  const sub = store.patches.find((p) => p.progress?.done === 8);
  assert.deepEqual([sub.progress.step, sub.progress.total], ['ingest_preliminary', 14]);
});

test('progress: sub-progress writes are throttled, log lines are not; a failed write never fails the run', async () => {
  const store = fakeStore();
  const r = progressReporter(store, 'run-1', { heartbeatMs: 60000, minGapMs: 60000 });
  await r.line('one');
  for (let i = 0; i < 20; i += 1) await r.progress('x', i, 20);
  await r.line('two');
  assert.equal(store.patches.length, 2, 'only the two log lines were written');
  const broken = progressReporter({ updateRun: async () => { throw new Error('network'); } }, 'run-2', { minGapMs: 0 });
  await assert.doesNotReject(broken.line('still fine'));
});

test("typical times: live B counts only runs that re-read the changed pages (not the first full re-read)", () => {
  const { stageTypical } = createRequire(import.meta.url)('../../api/_bau-progress.js');
  const run = (stage, mode, mins, mode2) => ({ status: 'succeeded', stages: [stage], mode, options: {}, started_at: '2026-11-03T10:00:00Z',
    finished_at: new Date(Date.parse('2026-11-03T10:00:00Z') + mins * 60000).toISOString(), stage_results: { [stage]: { refetch_mode: mode2 ?? null } } });
  assert.equal(stageTypical([run('B', 'live', 71), run('B', 'dry', 1)]).B.live, undefined, 'the 71 min full re-read is not counted');
  assert.equal(stageTypical([run('B', 'live', 71, 'full'), run('B', 'live', 12, 'changed')]).B.live, 12 * 60000);
  assert.equal(stageTypical([run('A', 'live', 2)]).A.live, 2 * 60000, 'other stages unchanged');
});
