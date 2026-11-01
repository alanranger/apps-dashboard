import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { executeRun, firstIncomplete, levelStatus } from '../../runner/engine.mjs';
import { memoryStore } from '../../runner/store.mjs';
import { applyRemovedFromGoogleRule, blogManifest, postsToRegenerate, csvRows, info, check, problem, levelCounts } from '../../runner/steps.mjs';
import { cooldownUntil, waitingText } from '../../runner/cooldown.mjs';

const { planStage, seedSources, stageHistory, stepsFor } = createRequire(import.meta.url)('../../runner/stages.cjs');

test('P25: a 429 in LIVE pre-flight waits 30 min then starts automatically; dry runs are unchanged', async () => {
  const now = Date.parse('2026-11-01T10:00:00Z');
  assert.equal(cooldownUntil({ mode: 'live', status: 429, now }), '2026-11-01T10:30:00.000Z');
  assert.equal(cooldownUntil({ mode: 'live', status: 200, last429At: '2026-11-01T09:50:00Z', now }), '2026-11-01T10:20:00.000Z', 'a 429 recorded 10 min ago still cools down');
  assert.equal(cooldownUntil({ mode: 'live', status: 200, last429At: '2026-11-01T09:00:00Z', now }), null, 'cool-down over: start now');
  assert.equal(cooldownUntil({ mode: 'dry', status: 429, now }), null, 'dry runs keep the old behaviour');
  assert.equal(waitingText('2026-11-01T10:30:00Z'), 'Waiting for Squarespace cool-down until 10:30');
  const store = memoryStore();
  const run = await store.createRun({ mode: 'live', cooldown_until: new Date(Date.now() + 60000).toISOString() });
  assert.equal(await store.nextRequested(), null, 'a cooling-down run is not picked up');
  await store.updateRun(run.id, { cooldown_until: new Date(Date.now() - 1000).toISOString() });
  assert.equal((await store.nextRequested()).id, run.id, 'picked up automatically once the cool-down has passed');
});

test('removed-from-Google rule: excludes gone Google reviews and lifts automatic exclusions, live only, with guards', async () => {
  const calls = [];
  const store = { query: async (p, opts) => { calls.push({ p, body: opts.body }); return null; } };
  const rec = { balanced: true, to_exclude: [{ id: 3328, name: 'Google X (2023-10-22)' }], to_unexclude: [{ id: 99, name: 'Google Y' }] };
  const dry = await applyRemovedFromGoogleRule({ mode: 'dry', store }, rec, true);
  assert.equal(dry.applied, false);
  assert.equal(calls.length, 0);
  const live = await applyRemovedFromGoogleRule({ mode: 'live', store }, rec, true);
  assert.equal(live.applied, true);
  assert.deepEqual(calls.map((c) => c.p), ['product_reviews?id=eq.3328', 'product_reviews?id=eq.99']);
  assert.equal(calls[0].body.is_excluded, true);
  assert.match(calls[0].body.exclude_reason, /^removed from Google \(auto, \d{4}-\d{2}-\d{2}\)$/);
  assert.deepEqual(calls[1].body, { is_excluded: false, exclude_reason: null });
  calls.length = 0;
  assert.equal((await applyRemovedFromGoogleRule({ mode: 'live', store }, rec, false)).applied, false, 'never after a failed fetch');
  const many = { ...rec, to_exclude: Array.from({ length: 6 }, (_, i) => ({ id: i, name: `G ${i}` })) };
  assert.equal((await applyRemovedFromGoogleRule({ mode: 'live', store }, many, true)).applied, false, 'never more than 5 at once');
  assert.equal(calls.length, 0);
});

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

test('registry has the 18 steps in stage order (A–I, each schema stage with its own publish step) with complete metadata', () => {
  const steps = JSON.parse(fs.readFileSync(new URL('../../runner/steps.json', import.meta.url), 'utf8'));
  assert.deepEqual(steps.map((s) => s.id), ['preflight', 'build_csvs', 'ingest_preliminary', 'reviews', 'product_schema', 'publish_products', 'event_posts', 'event_index',
    'publish_events', 'blog_index', 'blog_posts', 'publish_blogs', 'landing_pages', 'publish_landings', 'final_ingest', 'export_09', 'audit', 'summary']);
  assert.deepEqual(steps.map((s) => s.stage || '-').join(''), 'AABCDDEEEFFFGGHHI-');
  for (const s of steps) {
    for (const k of ['name', 'calls', 'where', 'inputs', 'outputs', 'prechecks', 'success', 'dry_run', 'duration', 'retry', 'on_fail']) assert.ok(k in s, `${s.id}.${k}`);
  }
});

test('levels: a problem fails the step, a check warns, info never does; a skipped ① (not selected) does not warn the run', async () => {
  assert.equal(levelStatus({ notes: [info('9 posts changed')] }).status, 'ok');
  assert.equal(levelStatus({ notes: [info('x'), check('look', 'do y')] }).status, 'warn');
  assert.equal(levelStatus({ notes: [problem('broken', 'fix')] }).status, 'fail');
  assert.equal(levelStatus({ status: 'skipped', notes: [info('not selected')] }).status, 'skipped');
  assert.equal(levelStatus({ warnings: ['legacy'] }).notes[0].level, 'check');
  const store = memoryStore();
  const run = await store.createRun({ mode: 'dry' });
  const h = { a: async () => ({ notes: [info('expected change')] }), b: async () => ({ status: 'skipped', notes: [info('not selected')] }),
    c: async () => ({ notes: [] }), d: async () => ({ notes: [] }) };
  assert.equal(await executeRun(store, run, REGISTRY, h, { mode: 'dry' }), 'succeeded');
  assert.deepEqual((await store.listSteps(run.id)).map((s) => s.status), ['ok', 'skipped', 'ok', 'ok']);
  assert.deepEqual(levelCounts((await store.listSteps(run.id)).map((s) => s.notes)), { info: 2, check: 0, problem: 0 });
});

const STAGED = [
  { id: 'preflight', ord: 1, name: 'P', stage: 'A', on_fail: 'stop' }, { id: 'build_csvs', ord: 2, name: 'B', stage: 'A', on_fail: 'stop' },
  { id: 'event_posts', ord: 3, name: 'E1', stage: 'E', on_fail: 'warn' }, { id: 'publish_events', ord: 4, name: 'E2', stage: 'E', on_fail: 'stop' },
  { id: 'summary', ord: 5, name: 'S', stage: null, on_fail: 'warn' }
];

test('stage results: written after a stage\'s last step, with the files that would be published; pre-flight alone does not complete stage A', async () => {
  const store = memoryStore();
  const run = await store.createRun({ mode: 'dry', stages: ['E'] });
  const h = { preflight: async () => ({}), event_posts: async () => ({ notes: [info('2 changed')] }),
    publish_events: async () => ({ counts: { files: ['a_event_schema.json', 'lessons-schema.json'] } }), summary: async () => ({}) };
  const reg = STAGED.filter((d) => d.id !== 'build_csvs');
  await executeRun(store, run, reg, h, { mode: 'dry', stages: ['E'], sandboxRoot: 'X:/sb' });
  const r = (await store.getRun(run.id)).stage_results;
  assert.deepEqual(Object.keys(r), ['E']);
  assert.equal(r.E.status, 'ok');
  assert.equal(r.E.sandbox, 'X:/sb');
  assert.deepEqual(r.E.published, ['a_event_schema.json', 'lessons-schema.json']);
  assert.equal(r.E.publish_mode, 'would publish');
});

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-11-01T12:00:00Z');
const done = (id, hoursAgo, status = 'ok') => [id, { status, mode: 'dry', finished_at: new Date(T0 - hoursAgo * 3600000).toISOString(), sandbox: `X:/${id}`, run_id: `r${id}` }];

test('prerequisites: missing / older than 7 days / run before its inputs changed → "Run A and B first", chain offered; never forced', () => {
  assert.deepEqual(stepsFor(['E']), ['preflight', 'event_posts', 'event_index', 'publish_events', 'summary']);
  assert.deepEqual(stepsFor(['A']), ['preflight', 'build_csvs', 'summary']);
  assert.equal(stepsFor(null), null);
  const none = planStage(['E'], {}, T0);
  assert.equal(none.ok, false);
  assert.equal(none.message, 'Run A and B first');
  assert.equal(none.chainLabel, 'Run A, B, then E');
  assert.deepEqual(none.chain, ['A', 'B', 'E']);
  assert.equal(planStage(['E'], Object.fromEntries([done('A', 5), done('B', 2)]), T0).ok, true);
  const old = planStage(['E'], Object.fromEntries([done('A', 8 * 24), done('B', 7 * 24 + 1)]), T0);
  assert.deepEqual(old.missing, ['A', 'B']);
  assert.match(old.reasons.A, /older than 7 days/);
  const stale = planStage(['E'], Object.fromEntries([done('A', 1), done('B', 3)]), T0);
  assert.deepEqual(stale.missing, ['B'], 'B ran before A last changed its inputs');
  assert.equal(stale.chainLabel, 'Run B, then E');
  assert.equal(planStage(['A', 'B', 'E'], {}, T0).ok, true, 'a chain carries its own prerequisites');
  assert.deepEqual(planStage(['H'], Object.fromEntries([done('A', 2)]), T0).missing, ['C', 'D'], 'H needs one of D–G');
  assert.equal(planStage(['H'], Object.fromEntries([done('A', 3), done('G', 1)]), T0).ok, true);
  assert.equal(planStage(['F'], Object.fromEntries([done('A', 2, 'fail')]), T0).message, 'Run A first');
  assert.deepEqual(seedSources(['E'], Object.fromEntries([done('A', 5), done('B', 2)])).map((s) => s.stage), ['A', 'B']);
});

test('stage history: latest result per stage for the run mode, newest run first', () => {
  const runs = [{ id: 'r2', stage_results: { E: { status: 'ok', mode: 'dry', finished_at: 'b' } } },
    { id: 'r1', stage_results: { A: { status: 'ok', mode: 'dry', finished_at: 'a' }, E: { status: 'fail', mode: 'dry', finished_at: 'a' } } }];
  const h = stageHistory(runs, 'dry');
  assert.equal(h.E.run_id, 'r2');
  assert.equal(h.A.run_id, 'r1');
  assert.deepEqual(stageHistory(runs, 'live'), {});
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
