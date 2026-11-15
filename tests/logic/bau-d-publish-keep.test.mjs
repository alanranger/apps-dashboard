import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { productKeepSet, productPublishSet, productRenameNotes, eventKeepSet } from '../../runner/steps.mjs';
import { keptRemovals } from '../../runner/publish-live.mjs';

const write = (dir, name, body) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), body);
};
const productDoc = (name) => `${JSON.stringify({ '@graph': [{ '@type': 'Product', name, offers: { price: '1' } }] })}\n`;

test('productKeepSet: live 04 keep includes may-and-july; stale sandbox keep does not clash detection', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bau-d-keep-'));
  const proc = path.join(root, 'csv processed');
  const products = path.join(root, 'outputs', 'schema', 'products');
  write(proc, '04 – alanranger_product_schema_FINAL_WITH_REVIEW_RATINGS.csv',
    'url,schema_file\nhttps://x/p,the-art-of-garden-photography-coventry-may-and-july_schema.json\n');
  write(products, 'the-art-of-garden-photography-coventry-may-and-july_schema.json', '{"ok":1}');
  write(products, 'the-art-of-garden-photography-coventry-may-and-july_faq.json', '{"ok":1}');
  const keep = productKeepSet(root, { requireFilesIn: products });
  assert.ok(keep.has('the-art-of-garden-photography-coventry-may-and-july_schema.json'));
  assert.ok(keep.has('the-art-of-garden-photography-coventry-may-and-july_faq.json'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('productPublishSet: fresh 04 rename retires may-and-july and does not clash with the fresh keep-set', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bau-d-pub-'));
  const shared = path.join(root, 'shared');
  const repo = path.join(root, 'repo');
  const products = path.join(shared, 'outputs', 'schema', 'products');
  const proc = path.join(shared, 'csv processed');
  const page = 'https://www.alanranger.com/photo-workshops-uk/garden-photography-workshop';
  const doc = (name) => `${JSON.stringify({ '@graph': [{ '@type': 'Product', name, url: page, offers: { price: '1' } }] })}\n`;
  write(proc, '04 – alanranger_product_schema_FINAL_WITH_REVIEW_RATINGS.csv',
    'f,the-art-of-garden-photography-coventry-may-jun-jul_schema.json\n');
  write(products, 'the-art-of-garden-photography-coventry-may-jun-jul_schema.json', doc('May Jun Jul'));
  write(products, 'the-art-of-garden-photography-coventry-may-jun-jul_faq.json', '{"@type":"FAQPage"}\n');
  write(repo, 'the-art-of-garden-photography-coventry-may-and-july_schema.json', doc('May and July'));
  write(repo, 'the-art-of-garden-photography-coventry-may-and-july_faq.json', '{"@type":"FAQPage"}\n');
  const set = productPublishSet({ shared, root }, repo);
  const freshKeep = productKeepSet(shared, { requireFilesIn: products });
  assert.ok(freshKeep.has('the-art-of-garden-photography-coventry-may-jun-jul_schema.json'));
  assert.equal(freshKeep.has('the-art-of-garden-photography-coventry-may-and-july_schema.json'), false);
  assert.deepEqual(set.remove.sort(), [
    'the-art-of-garden-photography-coventry-may-and-july_faq.json',
    'the-art-of-garden-photography-coventry-may-and-july_schema.json'
  ]);
  assert.deepEqual(keptRemovals(set.remove, freshKeep), []);
  assert.deepEqual(productRenameNotes(products, repo, set.publish, set.remove), [
    'removed (explained: renamed to the-art-of-garden-photography-coventry-may-jun-jul_schema.json): the-art-of-garden-photography-coventry-may-and-july_schema.json'
  ]);
  const staleRemove = ['the-art-of-garden-photography-coventry-may-jun-jul_schema.json'];
  assert.equal(keptRemovals(staleRemove, freshKeep).length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('eventKeepSet: hub files stay even when manifest is empty', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bau-e-keep-'));
  const manifest = path.join(dir, 'events-manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({ entries: [] }));
  const keep = eventKeepSet(manifest);
  assert.ok(keep.has('events-manifest.json'));
  assert.ok(keep.has('beginners-photography-lessons_faq.json'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('productPublishSet: unchanged keep-set file is not in publish (no mismatch bait)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bau-d-same-'));
  const shared = path.join(root, 'shared');
  const repo = path.join(root, 'repo');
  const products = path.join(shared, 'outputs', 'schema', 'products');
  const proc = path.join(shared, 'csv processed');
  const body = productDoc('Garden');
  write(proc, '04 – alanranger_product_schema_FINAL_WITH_REVIEW_RATINGS.csv',
    'f,the-art-of-garden-photography-coventry-may-and-july_schema.json\n');
  write(products, 'the-art-of-garden-photography-coventry-may-and-july_schema.json', body);
  write(products, 'the-art-of-garden-photography-coventry-may-and-july_faq.json', '{"@type":"FAQPage"}\n');
  write(repo, 'the-art-of-garden-photography-coventry-may-and-july_schema.json', body);
  write(repo, 'the-art-of-garden-photography-coventry-may-and-july_faq.json', '{"@type":"FAQPage"}\n');
  const set = productPublishSet({ shared, root }, repo);
  assert.deepEqual(set.publish, []);
  assert.deepEqual(set.remove, []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('productPublishSet: a stale 04 that still names may-and-july would delete the current may-jun-jul file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bau-d-rm-'));
  const shared = path.join(root, 'shared');
  const repo = path.join(root, 'repo');
  const products = path.join(shared, 'outputs', 'schema', 'products');
  const proc = path.join(shared, 'csv processed');
  write(proc, '04 – alanranger_product_schema_FINAL_WITH_REVIEW_RATINGS.csv',
    'f,the-art-of-garden-photography-coventry-may-and-july_schema.json\n');
  write(products, 'the-art-of-garden-photography-coventry-may-and-july_schema.json', productDoc('Old name'));
  write(products, 'the-art-of-garden-photography-coventry-may-and-july_faq.json', '{"@type":"FAQPage"}');
  write(repo, 'the-art-of-garden-photography-coventry-may-jun-jul_schema.json', productDoc('Current'));
  write(repo, 'the-art-of-garden-photography-coventry-may-jun-jul_faq.json', '{"@type":"FAQPage"}');
  const set = productPublishSet({ shared, root }, repo);
  const freshKeep = productKeepSet(shared, { requireFilesIn: products });
  assert.ok(set.remove.includes('the-art-of-garden-photography-coventry-may-jun-jul_schema.json'));
  assert.equal(keptRemovals(set.remove, freshKeep).length, 0);
  const currentKeep = new Set(['the-art-of-garden-photography-coventry-may-jun-jul_schema.json', 'the-art-of-garden-photography-coventry-may-jun-jul_faq.json']);
  assert.equal(keptRemovals(set.remove, currentKeep).length, 2);
  fs.rmSync(root, { recursive: true, force: true });
});
