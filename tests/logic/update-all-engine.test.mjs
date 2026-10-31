import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { executeRun, firstIncomplete } from '../../runner/engine.mjs';
import { memoryStore } from '../../runner/store.mjs';
import { blogManifest, postsToRegenerate, csvRows } from '../../runner/steps.mjs';

test('csvRows counts records, not lines (multi-line quoted cells)', () => {
  assert.equal(csvRows('a,b\n1,"x\ny\nz"\n2,w\n'), 2);
  assert.equal(csvRows('\uFEFFa,b\r\n1,2\r\n3,4'), 2);
});

const REGISTRY = [
  { id: 'a', ord: 1, name: 'A', on_fail: 'stop' },
  { id: 'b', ord: 2, name: 'B', on_fail: 'warn' },
  { id: 'c', ord: 3, name: 'C', on_fail: 'stop' },
  { id: 'd', ord: 4, name: 'D', on_fail: 'stop' }
];

function handlers(calls, overrides = {}) {
  const h = (id) => async () => { calls.push(id); return overrides[id] ? overrides[id]() : { status: 'ok', counts: { n: 1 } }; };
  return Object.fromEntries(REGISTRY.map((d) => [d.id, h(d.id)]));
}

test('steps run in order and every step is persisted', async () => {
  const store = memoryStore();
  const run = await store.createRun({ mode: 'dry' });
  const calls = [];
  const status = await executeRun(store, run, REGISTRY, handlers(calls), { mode: 'dry' });
  assert.equal(status, 'succeeded');
  assert.deepEqual(calls, ['a', 'b', 'c', 'd']);
  assert.deepEqual((await store.listSteps(run.id)).map((s) => s.status), ['ok', 'ok', 'ok', 'ok']);
});

test('a warn-and-continue failure is recorded and the run carries on as warned', async () => {
  const store = memoryStore();
  const run = await store.createRun({ mode: 'dry' });
  const calls = [];
  const status = await executeRun(store, run, REGISTRY, handlers(calls, { b: () => { throw new Error('boom'); } }), { mode: 'dry' });
  assert.equal(status, 'warned');
  assert.deepEqual(calls, ['a', 'b', 'c', 'd']);
  assert.equal((await store.listSteps(run.id))[1].status, 'fail');
});

test('a hard fail stops the run; resume continues from the failed step only', async () => {
  const store = memoryStore();
  const run = await store.createRun({ mode: 'dry' });
  const calls = [];
  assert.equal(await executeRun(store, run, REGISTRY, handlers(calls), { mode: 'dry', failStep: 'c' }), 'failed');
  assert.deepEqual(calls, ['a', 'b']);
  assert.equal((await store.getRun(run.id)).status, 'failed');
  assert.equal(firstIncomplete(REGISTRY, await store.listSteps(run.id)), 2);
  const resumed = [];
  assert.equal(await executeRun(store, await store.getRun(run.id), REGISTRY, handlers(resumed), { mode: 'dry' }), 'succeeded');
  assert.deepEqual(resumed, ['c', 'd']);
  const c = (await store.listSteps(run.id)).find((s) => s.step_id === 'c');
  assert.equal(c.attempt, 2);
  assert.equal(c.status, 'ok');
});

test('registry has the 14 steps in the agreed order with complete metadata', () => {
  const steps = JSON.parse(fs.readFileSync(new URL('../../runner/steps.json', import.meta.url), 'utf8'));
  assert.deepEqual(steps.map((s) => s.id), ['preflight', 'build_csvs', 'ingest_preliminary', 'reviews', 'product_schema', 'event_posts',
    'blog_index', 'blog_posts', 'landing_pages', 'deploy', 'final_ingest', 'export_09', 'audit', 'summary']);
  for (const s of steps) {
    for (const k of ['name', 'calls', 'where', 'inputs', 'outputs', 'prechecks', 'success', 'dry_run', 'duration', 'retry', 'on_fail']) assert.ok(k in s, `${s.id}.${k}`);
  }
});

test('blog body-hash gate: new and changed posts regenerate, an updatedOn bump alone does not', () => {
  const item = (slug, body, updatedOn) => ({ fullUrl: `/blog-on-photography/${slug}`, body, updatedOn });
  const row = (slug, title) => ({ 'Full Url': `https://www.alanranger.com/blog-on-photography/${slug}`, Title: title });
  const baseline = blogManifest([item('a', 'A', 1), item('b', 'B', 1), item('c', 'C', 1), item('d', 'D', 1)], [row('a', 'A'), row('b', 'B'), row('c', 'C'), row('d', 'D')]);
  const current = blogManifest([item('a', 'A', 1), item('b', 'B2', 2), item('c', 'C', 3), item('d', 'D', 1), item('e', 'E', 1)],
    [row('a', 'A'), row('b', 'B'), row('c', 'C'), row('d', 'D new title'), row('e', 'E')]);
  const r = postsToRegenerate(current, baseline);
  const slugs = (list) => list.map((u) => u.split('/').pop());
  assert.deepEqual(slugs(r.fresh), ['e']);
  assert.deepEqual(slugs(r.changed), ['b', 'd']);
  assert.deepEqual(slugs(r.touchedOnly), ['c']);
});
