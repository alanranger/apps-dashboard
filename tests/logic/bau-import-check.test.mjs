import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkImports, missingMessage } from '../../runner/import-check.mjs';
import { scriptFailure, blogBodyKey } from '../../runner/steps.mjs';

test('blog body key ignores Squarespace platform markup (component asset versions, lightbox styles) but not content', () => {
  const v1 = '<div data-block-css="[&quot;https://definitions.sqspcdn.com/website-component-definition/static-assets/website.components.code/59a0_1074/x.css&quot;]"><style>.cdk-image-lightbox .sqs-lightbox-meta{margin:0}</style><p>Updated 29 Oct</p><style>.ar-x{color:red}</style></div>';
  const v2 = '<div data-block-css="[&quot;https://definitions.sqspcdn.com/website-component-definition/static-assets/website.components.code/4e54_1080/x.css&quot;]"><style>.cdk-image-lightbox .sqs-lightbox-meta{margin:0;padding:20px}</style><p>Updated 29 Oct</p><style>.ar-x{color:red}</style></div>';
  assert.equal(blogBodyKey(v1), blogBodyKey(v2));
  assert.notEqual(blogBodyKey(v1), blogBodyKey(v2.replace('29 Oct', '4 Nov')));
  assert.notEqual(blogBodyKey(v1), blogBodyKey(v1.replace('.ar-x{color:red}', '.ar-x{color:blue}')));
});

test('blog body key ignores whitespace re-renders and summary blocks (other posts / upcoming events), not content', () => {
  const block = (cls, inner) => `<div class="sqs-block ${cls}" data-block-type="1337"><div class="sqs-block-content">${inner}</div></div>`;
  const page = (text, summary, gap = '') => `<div class="row sqs-row">${gap}${block('html-block', `<p>${text}</p>`)}${gap}`
    + `${block('website-component-block summary-v2-block', summary)}${block('html-block', '<p>Footer</p>')}</div>`;
  const v1 = page('Light matters', '<p>Old excerpt</p><div data-upcoming-event-end="1">Event</div>');
  assert.equal(blogBodyKey(v1), blogBodyKey(page('Light matters', '<p>New excerpt</p>', '\n\n    ')));
  assert.notEqual(blogBodyKey(v1), blogBodyKey(page('Light really matters', '<p>Old excerpt</p>')));
  assert.notEqual(blogBodyKey(v1), blogBodyKey(v1.replace('Footer', 'New footer')));
});

function project() {
  const web = fs.mkdtempSync(path.join(os.tmpdir(), 'imports-'));
  const dir = path.join(web, 'Tool');
  fs.mkdirSync(path.join(dir, 'scripts', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'node_modules', 'listed-lib'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'node_modules', 'stray-lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'listed-lib', 'package.json'), '{"name":"listed-lib"}');
  fs.writeFileSync(path.join(dir, 'node_modules', 'stray-lib', 'package.json'), '{"name":"stray-lib"}');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'tool', dependencies: { 'listed-lib': '1.0.0' } }));
  fs.writeFileSync(path.join(dir, 'scripts', 'main.mjs'), "import fs from 'node:fs';\nimport { a } from './lib/helper.mjs';\nimport x from 'listed-lib';\n");
  fs.writeFileSync(path.join(dir, 'scripts', 'lib', 'helper.mjs'), "import { chromium } from 'gone-lib';\nconst y = await import('stray-lib/sub');\nexport const a = 1;\n");
  return web;
}

test('import check: a missing library (followed through local imports) and an installed-but-unlisted one', () => {
  const r = checkImports([['Tool/scripts/main.mjs', 'the demo generator']], project());
  assert.deepEqual(r.missing.map((m) => [m.pkg, m.needed_by]), [['gone-lib', ['the demo generator']]]);
  assert.deepEqual(r.unlisted.map((u) => [u.pkg, u.project]), [['stray-lib', 'Tool']]);
  assert.equal(missingMessage(r.missing[0]), 'Missing code library: gone-lib (needed by the demo generator). Nothing was run.');
});

test('a failed script: one plain line naming the missing library in full, the whole output kept for Details', () => {
  const stderr = "node:internal/modules/package_json_reader:316\n  throw new ERR_MODULE_NOT_FOUND(packageName);\nError [ERR_MODULE_NOT_FOUND]: Cannot find package 'playwright' imported from G:/x/app-cli.mjs\n    at packageResolve\n";
  const f = scriptFailure('Blog posts generator', { code: 1, stderr, stdout: '' });
  assert.equal(f.plain, "Blog posts generator couldn't start: missing code library playwright");
  assert.match(f.todo, /npm install/);
  assert.ok(f.details.some((l) => l.includes("Cannot find package 'playwright'")));
  const other = scriptFailure('Event index generator', { code: 1, stderr: 'TypeError: x is not a function\n    at y', stdout: '' });
  assert.equal(other.plain, 'Event index generator failed: TypeError: x is not a function');
});
