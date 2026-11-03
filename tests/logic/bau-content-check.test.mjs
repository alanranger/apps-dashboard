import test from 'node:test';
import assert from 'node:assert/strict';
import { contentFingerprint, contentParts } from '../../runner/content-fingerprint.mjs';
import { checkPages, decide, planSummary, reingestList } from '../../runner/content-check.mjs';

/** A Squarespace-like page: noise varies per call (crumb, cache-buster, format=, related products, pager), content doesn't. */
const page = ({ body = '<p>Long exposure guide: use a tripod.</p>', noise = 1, schema = ['https://schema.alanranger.com/blog-schema.json'] } = {}) => `<!doctype html><html><head>
<script>Static.SQUARESPACE_CONTEXT = {"crumb":"tok${noise}","ts":${Date.now() + noise}}</script>
${schema.map((s) => `<script src="${s}?v=${noise}"></script>`).join('')}<link href="/style.css?cb=${noise}"></head>
<body><header><nav><a href="/x">Menu ${noise}</a></nav></header><main class="Main"><section class="Main-content" data-content-field="main-content">
<article class="BlogItem"><h1>Long Exposure</h1>${body}
<img src="https://images.squarespace-cdn.com/content/v1/abc/photo.jpg?format=${noise % 2 ? '750w' : '1500w'}">
<form><input name="crumb" value="tok${noise}"></form>
<div class="BlogItem-pagination"><a>Previous: post ${noise}</a></div>
<section class="ProductItem-related"><div><h2>You Might Also Like</h2><a>Workshop ${noise}</a></div></section>
<div class="eventitem-pager"><div class="eventitem-pager-older">Earlier Event: ${noise} Nov</div></div>
<div class="Share-buttons"><span class="Share-buttons-item-count">${noise}</span></div>
</article></section></main><footer>© ${noise}</footer></body></html>`;

test('fingerprint ignores Squarespace noise: tokens, cache-busters, format=, pager, related products, share counts', () => {
  const a = contentFingerprint(page({ noise: 1 }));
  for (let n = 2; n < 8; n += 1) assert.equal(contentFingerprint(page({ noise: n })), a, `noise variant ${n}`);
  const p = contentParts(page({ noise: 3 }));
  assert.match(p.text, /Long Exposure Long exposure guide: use a tripod\./);
  assert.doesNotMatch(p.text, /Previous|You Might Also Like|Earlier Event|Menu|©/);
  assert.deepEqual(p.images, ['https://images.squarespace-cdn.com/content/v1/abc/photo.jpg']);
});

test('fingerprint detects real edits: body text, an added image, the hosted schema references', () => {
  const base = contentFingerprint(page());
  assert.notEqual(contentFingerprint(page({ body: '<p>Long exposure guide: use a sturdy tripod.</p>' })), base, 'one word');
  assert.notEqual(contentFingerprint(page({ body: '<p>Long exposure guide: use a tripod.</p><img src="https://images.squarespace-cdn.com/x/new.jpg">' })), base, 'new image');
  assert.notEqual(contentFingerprint(page({ schema: [] })), base, 'schema reference removed');
});

test('decide: new / changed / no fingerprint / unchanged / check failed', () => {
  const stored = new Map([['a', 'F1']]);
  const known = new Set(['a', 'b']);
  assert.equal(decide('a', 'F1', stored, known), 'unchanged');
  assert.equal(decide('a', 'F2', stored, known), 'changed');
  assert.equal(decide('b', 'F1', stored, known), 'no_fingerprint');
  assert.equal(decide('c', 'F1', stored, known), 'new');
  assert.equal(decide('a', null, stored, known), 'check_failed');
});

test('check: every url fetched (6 at a time), progress counted, only non-unchanged re-ingested; force re-reads all', async () => {
  const html = { u1: page(), u2: page({ body: '<p>edited</p>' }), u3: page(), u4: null };
  const stored = new Map([['u1', contentFingerprint(page({ noise: 9 }))], ['u2', contentFingerprint(page())]]);
  let inFlight = 0; let peak = 0; const progress = [];
  const fetchPageFn = async (u) => { inFlight += 1; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 5)); inFlight -= 1; return { status: html[u] ? 200 : 0, html: html[u] }; };
  const urls = ['u1', 'u2', 'u3', 'u4', ...Array.from({ length: 20 }, (_, i) => `x${i}`)];
  const results = await checkPages(urls, { stored, known: new Set(['u3']), fetchPageFn, onProgress: (l, d, t) => progress.push([d, t]) });
  assert.ok(peak <= 6, `at most 6 in flight (${peak})`);
  assert.deepEqual(progress.at(-1), [urls.length, urls.length]);
  const by = Object.fromEntries(results.slice(0, 4).map((r) => [r.url, r.reason]));
  assert.deepEqual(by, { u1: 'unchanged', u2: 'changed', u3: 'no_fingerprint', u4: 'check_failed' });
  assert.ok(!reingestList(results).some((r) => r.url === 'u1'), 'the unchanged page is not re-ingested');
  const plan = planSummary(results);
  assert.equal(plan.unchanged, 1);
  assert.equal(plan.reingest, urls.length - 1);
  assert.equal(planSummary(results, true).reingest, urls.length, 'force: everything');
  assert.equal(planSummary(results, true).list.find((r) => r.url === 'u1').reason, 'forced');
});
