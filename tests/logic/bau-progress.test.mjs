import test from 'node:test';
import assert from 'node:assert/strict';
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
