import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { coverage, coverageLine } from '../../runner/coverage.mjs';

function repo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cov-'));
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), '{}');
  }
  return dir;
}

test('coverage maps every schema repo file to its producing step; loaders/, Assignments/ and meta files are exempt', () => {
  const dir = repo(['loaders/landing-page-loader.js', 'Assignments/a.json', 'README.md', 'CNAME', '.gitignore',
    'kit_schema.json', 'kit_faq.json', 'products-manifest.json',
    'a-1_event_schema.json', 'events-manifest.json', 'beginners-photography-lessons_faq.json', 'photographic-workshops-near-me_faq.json',
    'lessons-schema.json', 'workshops-schema.json', 'blog-schema.json',
    'post_schema.json', 'post_blogposting.json', 'post_breadcrumb.json', 'post_image.json', 'post_howto.json', 'post_faq.json',
    'home_landing_schema.json', 'landings-manifest.json']);
  const c = coverage(dir, new Set(['kit_schema.json', 'kit_faq.json']), new Set(['post']));
  assert.deepEqual(c.orphans, []);
  assert.deepEqual(c.byStep, { product_schema: 3, event_index: 2, event_posts: 4, blog_index: 1, blog_posts: 6, landing_pages: 2 });
  assert.deepEqual(c.uncoveredTabs, []);
  assert.equal(coverageLine(c), 'Coverage: 18 files, all produced by a step');
});

test('a file no step produces is named as an orphan; a tab with no files is reported', () => {
  const dir = repo(['organization-homepage-reviews.json', 'products-schema.json', 'kit_schema.json']);
  const c = coverage(dir, new Set(['kit_schema.json']), new Set());
  assert.deepEqual(c.orphans.sort(), ['organization-homepage-reviews.json', 'products-schema.json']);
  assert.match(coverageLine(c), /2 with no producer: .*organization-homepage-reviews\.json/);
  assert.ok(c.uncoveredTabs.includes('Event Index'));
});
