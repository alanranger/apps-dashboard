import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { productKeepSet, productPublishSet, eventKeepSet } from '../../runner/steps.mjs';

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

test('productPublishSet: stale 04 wanting old names would remove live may-and-july (caught by liveKeep)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bau-d-pub-'));
  const shared = path.join(root, 'shared');
  const repo = path.join(root, 'repo');
  const products = path.join(shared, 'outputs', 'schema', 'products');
  const proc = path.join(shared, 'csv processed');
  write(proc, '04 – alanranger_product_schema_FINAL_WITH_REVIEW_RATINGS.csv',
    'f,the-art-of-garden-photography-coventry-may-jun-jul_schema.json\n');
  write(products, 'the-art-of-garden-photography-coventry-may-jun-jul_schema.json', '{"old":1}');
  write(products, 'the-art-of-garden-photography-coventry-may-jun-jul_faq.json', '{"old":1}');
  write(repo, 'the-art-of-garden-photography-coventry-may-and-july_schema.json', productDoc('Garden'));
  write(repo, 'the-art-of-garden-photography-coventry-may-and-july_faq.json', '{"@type":"FAQPage"}');
  const set = productPublishSet({ shared, root }, repo);
  assert.deepEqual(set.remove.sort(), [
    'the-art-of-garden-photography-coventry-may-and-july_faq.json',
    'the-art-of-garden-photography-coventry-may-and-july_schema.json'
  ]);
  const liveKeep = new Set([
    'the-art-of-garden-photography-coventry-may-and-july_schema.json',
    'the-art-of-garden-photography-coventry-may-and-july_faq.json'
  ]);
  const clash = set.remove.filter((f) => liveKeep.has(f));
  assert.equal(clash.length, 2);
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

test('productPublishSet: real rename leftover is listed in remove', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bau-d-rm-'));
  const shared = path.join(root, 'shared');
  const repo = path.join(root, 'repo');
  const products = path.join(shared, 'outputs', 'schema', 'products');
  const proc = path.join(shared, 'csv processed');
  write(proc, '04 – alanranger_product_schema_FINAL_WITH_REVIEW_RATINGS.csv',
    'f,the-art-of-garden-photography-coventry-may-and-july_schema.json\n');
  write(products, 'the-art-of-garden-photography-coventry-may-and-july_schema.json', productDoc('New'));
  write(products, 'the-art-of-garden-photography-coventry-may-and-july_faq.json', '{"@type":"FAQPage"}');
  write(repo, 'the-art-of-garden-photography-coventry-may-jun-jul_schema.json', productDoc('Old'));
  write(repo, 'the-art-of-garden-photography-coventry-may-jun-jul_faq.json', '{"@type":"FAQPage"}');
  write(repo, 'the-art-of-garden-photography-coventry-may-and-july_schema.json', productDoc('Live'));
  write(repo, 'the-art-of-garden-photography-coventry-may-and-july_faq.json', '{"@type":"FAQPage"}');
  const set = productPublishSet({ shared, root }, repo);
  assert.ok(set.publish.includes('the-art-of-garden-photography-coventry-may-and-july_schema.json'));
  assert.deepEqual(set.remove.sort(), [
    'the-art-of-garden-photography-coventry-may-jun-jul_faq.json',
    'the-art-of-garden-photography-coventry-may-jun-jul_schema.json'
  ]);
  fs.rmSync(root, { recursive: true, force: true });
});
