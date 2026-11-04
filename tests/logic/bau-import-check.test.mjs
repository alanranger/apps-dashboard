import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkImports, missingMessage } from '../../runner/import-check.mjs';
import { scriptFailure } from '../../runner/steps.mjs';

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
