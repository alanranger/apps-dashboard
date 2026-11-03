import test from 'node:test';
import assert from 'node:assert/strict';
import { findRemovals, explainRemoval, checkPublishSet } from '../../runner/removals.mjs';
import { liveReadiness } from '../../runner/update-all-runner.mjs';
import { LIVE_STAGES } from '../../runner/publish-live.mjs';

const g = (...nodes) => ({ '@context': 'https://schema.org', '@graph': nodes });

test('removals: an offer / rating / reviews lost on ANY node is found (not only the business node)', () => {
  const before = g({ '@id': 'p#service', '@type': 'Service', offers: { '@type': 'Offer', price: '99' }, aggregateRating: { ratingValue: 5 }, review: [{}, {}, {}] });
  const after = g({ '@id': 'p#service', '@type': 'Service' });
  const what = findRemovals(before, after).map((r) => r.what);
  assert.ok(what.includes('offers removed'));
  assert.ok(what.includes('aggregateRating removed'));
  assert.ok(what.includes('reviews 3 → 0'));
  assert.ok(what.includes('@type Offer no longer anywhere in the file'));
});

test('removals: a node that only changed @id (rebuilt breadcrumb) is not a loss; a gone priced node is', () => {
  const before = g({ '@id': 'a#bc', '@type': 'BreadcrumbList' }, { '@id': 'a#product', '@type': 'Product', offers: { price: '50' } });
  const after = g({ '@id': 'a#breadcrumbs', '@type': 'BreadcrumbList' });
  const rows = findRemovals(before, after);
  assert.deepEqual(rows.filter((r) => r.what === 'node removed').map((r) => r.node), ['a#product']);
});

test('removals: re-ordered offers with the same priceSpecification count lose nothing (Lake District case)', () => {
  const offers = (order) => order.map((n) => ({ '@type': 'Offer', sku: n, ...(n === 'jan' ? {} : { priceSpecification: { price: '1075' } }) }));
  assert.deepEqual(findRemovals(g({ '@id': 'x#product', '@type': 'Product', offers: offers(['nov', 'jan', 'sep']) }),
    g({ '@id': 'x#product', '@type': 'Product', offers: offers(['jan', 'sep', 'nov']) })), []);
});

test('removals: explanations — P23 business rating, landing "no list", D review re-homing, past events; Course rating is NOT P23', () => {
  assert.match(explainRemoval({ prop: 'aggregateRating', nodeTypes: ['LocalBusiness', 'Organization'] }, { stage: 'G' }), /P23/);
  assert.equal(explainRemoval({ prop: 'aggregateRating', nodeTypes: ['Course'] }, { stage: 'G' }), null);
  assert.match(explainRemoval({ type: 'ItemList' }, { stage: 'G', landingNote: 'ItemList removed (2 items before): the page shows no list of pages' }), /no list/);
  const reviews04 = (id) => ({ 'https://x/p': '3' })[id.split('#')[0]] ?? null;
  assert.match(explainRemoval({ prop: 'review', node: 'https://x/p#product', to: 3 }, { stage: 'D', reviews04 }), /re-homing/);
  assert.match(explainRemoval({ prop: 'review', node: 'https://x/p#event', to: 3 }, { stage: 'E', reviews04 }), /re-homing/, 'the same rule for E');
  assert.equal(explainRemoval({ prop: 'review', node: 'https://x/p#event', to: 2 }, { stage: 'E', reviews04 }), null, 'a count that does not match 04 stays unexplained');
  assert.match(explainRemoval({ what: 'node removed', pastEvent: true }, { stage: 'E' }), /past-dated/);
  assert.equal(explainRemoval({ type: 'Organization', what: '@type Organization no longer anywhere in the file' }, { stage: 'E' }), null);
});

test('removals: checkPublishSet lists the files with unexplained removals', () => {
  const docs = { 'a.json': [g({ '@id': 'a', '@type': 'Product', offers: {} }), g({ '@id': 'a', '@type': 'Product' })], 'b.json': [g({ '@id': 'b', '@type': 'Thing' }), g({ '@id': 'b', '@type': 'Thing' })] };
  const r = checkPublishSet(Object.keys(docs), { readBefore: (f) => docs[f][0], readAfter: (f) => docs[f][1], contextFor: () => ({ stage: 'G' }) });
  assert.deepEqual(r.files_with_unexplained, ['a.json']);
});

test('live: the file stages A, C and D–G are live-capable; readiness refuses a missing, failed, old, unexplained or vanished dry run', () => {
  assert.deepEqual([...LIVE_STAGES], ['A', 'C', 'D', 'E', 'F', 'G']);
  const now = Date.parse('2026-11-03T12:00:00Z');
  const ok = { status: 'warn', finished_at: '2026-11-02T21:03:07Z', removals_unexplained: 0, sandbox: process.cwd() };
  assert.equal(liveReadiness('F', ok, now), null);
  assert.match(liveReadiness('F', null, now), /never been dry-run/);
  assert.match(liveReadiness('F', { ...ok, status: 'fail' }, now), /fail/);
  assert.match(liveReadiness('F', { ...ok, finished_at: '2026-10-20T00:00:00Z' }, now), /older than 7 days/);
  assert.match(liveReadiness('F', { ...ok, removals_unexplained: 3 }, now), /3 unexplained removals/);
  assert.match(liveReadiness('F', { ...ok, removals_unexplained: null }, now), /predates the removal check/);
  assert.match(liveReadiness('F', { ...ok, sandbox: 'C:/no/such/folder' }, now), /gone from this PC/);
});
