import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { applyChoices, heldItems, reviewKey } from '../../runner/held-reviews.mjs';
import { executeRun, firstIncomplete, levelStatus } from '../../runner/engine.mjs';
import { memoryStore } from '../../runner/store.mjs';
import { applyRemovedFromGoogleRule, blogManifest, postsToRegenerate, csvRows, info, check, problem, levelCounts } from '../../runner/steps.mjs';
import { cooldownUntil, parkDecision, probeFor, rateLimitedNeed, waitingText } from '../../runner/cooldown.mjs';

const { planStage, seedSources, stageHistory, liveDoneHistory, stepsFor } = createRequire(import.meta.url)('../../runner/stages.cjs');

test('live history: a refused live run does not hide the publish before it; an undo does', () => {
  const pub = { id: 'r1', stage_results: { D: { status: 'ok', mode: 'live', commit: 'b1ba40f8' } } };
  const refused = { id: 'r2', stage_results: { D: { status: 'fail', mode: 'live', commit: null } } };
  assert.equal(stageHistory([refused, pub], 'live').D.run_id, 'r2', 'the latest attempt is still shown');
  assert.equal(liveDoneHistory([refused, pub]).D.run_id, 'r1', 'unlock rule and Undo use the publish');
  const undo = { id: 'r3', stage_results: { D: { status: 'ok', mode: 'live', undo_of: 'r1' } } };
  assert.equal(liveDoneHistory([undo, refused, pub]).D.undo_of, 'r1', 'after an undo the latest ok result is the undo');
});

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

test('batch 8 cool-down: Retry-After honoured, probe changes after a park, a third park in a row goes to Needs Alan', () => {
  const now = Date.parse('2026-11-02T10:00:00Z');
  assert.equal(cooldownUntil({ mode: 'live', status: 429, retryAfterMs: 45 * 60000, now }), '2026-11-02T10:45:00.000Z', 'a longer Retry-After wins');
  assert.equal(cooldownUntil({ mode: 'live', status: 429, retryAfterMs: 5000, now }), '2026-11-02T10:30:00.000Z', 'never shorter than 30 min');
  assert.equal(probeFor(0), 'https://www.alanranger.com/');
  assert.equal(probeFor(1), 'https://www.alanranger.com/robots.txt', 'after a cool-down the same request is not repeated');
  assert.equal(parkDecision({ status: 200, until: null, parks: 2 }), 'go');
  assert.equal(parkDecision({ status: 200, until: '2026-11-02T10:20:00Z', parks: 1 }), 'wait', 'still cooling down from an earlier 429: no new park');
  assert.equal(parkDecision({ status: 429, until: '2026-11-02T10:30:00Z', parks: 0 }), 'park');
  assert.equal(parkDecision({ status: 429, until: '2026-11-02T10:30:00Z', parks: 1 }), 'park');
  assert.equal(parkDecision({ status: 429, until: '2026-11-02T10:30:00Z', parks: 2 }), 'needs_alan', 'parked twice already: the third 429 asks Alan');
  assert.match(rateLimitedNeed(2).file, /3 times in a row/);
});

test('held reviews: each page choice becomes one 15-override row (+ alias for products), never twice; cards hold first name + text only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'held-'));
  const overridesFile = path.join(dir, '15.csv');
  const aliasFile = path.join(dir, '16.csv');
  fs.writeFileSync(overridesFile, '\uFEFFsource,reviewer_name,review_date,reference_id,product_slug,scope,priority,notes\r\nGoogle,Old Person,2025-01-01,,x,product,100,old\r\n');
  const googleRows = [{ reviewer: 'Jane Example', date: '2026-11-01', review: 'Lovely' }, { reviewer: 'Bob Sample', date: '2026-10-30', review: 'Nice' },
    { reviewer: 'Cat Third', date: '2026-10-29', review: 'Meh' }, { reviewer: 'Not Decided', date: '2026-10-28', review: '?' }];
  const choices = [{ review_key: reviewKey('Jane Example', '2026-11-01'), choice: 'product', product_slug: 'batsford-arboretum-photography-workshops', decided_at: '2026-11-01T18:00:00Z' },
    { review_key: reviewKey('Bob Sample', '2026-10-30'), choice: 'business_level' }, { review_key: reviewKey('Cat Third', '2026-10-29'), choice: 'exclude', reason: 'about a print' }];
  const r = applyChoices({ choices, googleRows, overridesFile, aliasFile, today: '2026-11-02' });
  assert.equal(r.applied.length, 3);
  assert.equal(r.overrides_added, 3);
  const lines15 = fs.readFileSync(overridesFile, 'utf8').split('\r\n').filter(Boolean);
  assert.equal(lines15.length, 5, 'header + old row + 3 new rows, CRLF kept');
  assert.deepEqual(lines15.slice(2), ['Google,Jane Example,2026-11-01,,batsford-arboretum-photography-workshops,product,100,alan_confirmed_2026-11-01',
    'Google,Bob Sample,2026-10-30,,,business_level,100,alan_confirmed_2026-11-02', 'Google,Cat Third,2026-10-29,,,exclude,100,alan_confirmed_2026-11-02_exclude_about a print']);
  assert.match(fs.readFileSync(aliasFile, 'utf8'), /Jane Example,batsford-arboretum-photography-workshops,2026-11-02,bau_review_choice/);
  assert.equal(applyChoices({ choices, googleRows, overridesFile, aliasFile, today: '2026-11-03' }).overrides_added, 0, 'never added twice');
  const cards = heldItems([{ reviewer: 'Not Decided Person', date: '2026-10-28', rating: 'FOUR', review: 'x'.repeat(400), suggested_product_slug: '' }],
    [{ reviewer: 'Not Decided Person', date: '2026-10-28', orders_slug: 'garden-photography-workshop', orders_why: 'hold: text names a, order is b', candidates: ['a', 'b', 'c', 'd'] }]);
  assert.equal(cards[0].first_name, 'Not');
  assert.equal(cards[0].rating, 4);
  assert.equal(cards[0].suggested, 'garden-photography-workshop');
  assert.deepEqual(cards[0].alternatives, ['a', 'b', 'c']);
  assert.ok(!JSON.stringify(cards[0]).includes('Decided Person'), 'no full name on the card');
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

test('registry has the 19 steps in stage order (A–I, each schema stage with its own publish step) with complete metadata', () => {
  const steps = JSON.parse(fs.readFileSync(new URL('../../runner/steps.json', import.meta.url), 'utf8'));
  assert.deepEqual(steps.map((s) => s.id), ['preflight', 'build_csvs', 'ingest_preliminary', 'reviews', 'product_schema', 'publish_products', 'event_posts', 'event_index',
    'publish_events', 'blog_index', 'blog_posts', 'publish_blogs', 'landing_pages', 'blocks_css', 'publish_landings', 'final_ingest', 'export_09', 'audit', 'summary']);
  assert.deepEqual(steps.map((s) => s.stage || '-').join(''), 'AABCDDEEEFFFGGGHHI-');
  assert.deepEqual(steps.map((s) => s.ord), steps.map((_, i) => i + 1));
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

test('live stage results record the commit, files, repo and promoted dry run (A publishes from its generator step)', async () => {
  const store = memoryStore();
  const run = await store.createRun({ mode: 'live', stages: ['A'] });
  const files = ['csv/01-blog-posts.csv', 'csv/03-photographic-workshops-near-me.csv'];
  const h = { preflight: async () => ({}), summary: async () => ({}),
    build_csvs: async () => ({ counts: { files, commit: 'abc123', promoted_from: 'dry-1', repo_name: 'alan-shared-resources' } }) };
  const reg = STAGED.filter((d) => ['preflight', 'build_csvs', 'summary'].includes(d.id));
  await executeRun(store, run, reg, h, { mode: 'live', stages: ['A'], promote: { stage: 'A', run_id: 'dry-1' } });
  const a = (await store.getRun(run.id)).stage_results.A;
  assert.equal(a.commit, 'abc123');
  assert.deepEqual(a.published, files);
  assert.equal(a.publish_mode, 'published');
  assert.equal(a.repo, 'alan-shared-resources');
  assert.equal(a.promoted_from, 'dry-1');
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

test('blog gate across a hash-version change: body hashes are not compared, an updatedOn bump counts as the change', () => {
  const item = (slug, body, updatedOn) => ({ fullUrl: `/blog-on-photography/${slug}`, body, updatedOn });
  const baseline = { ...blogManifest([item('a', 'A', 1), item('b', 'B', 1)], []) };
  for (const p of Object.values(baseline)) p.bodyHash = 'older-version-hash';
  const current = blogManifest([item('a', 'A', 1), item('b', 'B2', 2)], []);
  const slugs = (list) => list.map((u) => u.split('/').pop());
  assert.deepEqual(slugs(postsToRegenerate(current, baseline).changed), ['a', 'b']);
  assert.deepEqual(slugs(postsToRegenerate(current, baseline, { bodyComparable: false }).changed), ['b']);
});
