import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EMPTY_COMPARE, parseCompare, emptyPosts, emptyPostNotes, feedsNote } from '../../runner/blog-gone.mjs';

const levels = { info: (text) => ({ level: 'info', text }), check: (text, todo) => ({ level: 'check', text, todo }), problem: (text, todo) => ({ level: 'problem', text, todo }) };
const SITE = 'https://www.alanranger.com/blog-on-photography';
const fakeFetch = (codes) => async (url) => ({ status: codes[url] ?? 404, body: null });

test('compare output with no JSON gives null (the caller uses EMPTY_COMPARE), never an exception', () => {
  assert.equal(parseCompare(''), null);
  assert.equal(parseCompare('Error: ENOENT: no such file or directory'), null);
  assert.equal(parseCompare('{ broken'), null);
  assert.deepEqual(parseCompare('noise\n{"compared":0,"differing":[],"new_files":[]}'), { compared: 0, differing: [], new_files: [] });
  assert.deepEqual(EMPTY_COMPARE, { differing: [], new_files: [] });
});

test('every selected post is 404: "no longer exist on the site; nothing to regenerate", a check (WARN), no problem', async () => {
  const urls = [`${SITE}/old-a`, `${SITE}/old-b`];
  const posts = [{ slug: 'old-a', files: [] }, { slug: 'old-b', files: [] }];
  const empty = await emptyPosts(posts, urls, { fetchFn: fakeFetch({}), gapMs: 0 });
  assert.deepEqual(empty, { gone: urls, failed: [] });
  const notes = emptyPostNotes(empty, urls.length, levels);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].level, 'check');
  assert.equal(notes[0].text, '2 posts listed in the feed no longer exist on the site; nothing to regenerate.');
});

test('some posts gone, one built, one not built while live: gone ones skipped, the live one is a problem', async () => {
  const urls = [`${SITE}/gone`, `${SITE}/built`, `${SITE}/broken`];
  const posts = [{ slug: 'gone', files: [] }, { slug: 'built', files: ['built_schema.json'] }, { slug: 'broken', files: [] }];
  const empty = await emptyPosts(posts, urls, { fetchFn: fakeFetch({ [`${SITE}/broken`]: 200 }), gapMs: 0 });
  assert.deepEqual(empty.gone, [`${SITE}/gone`]);
  assert.deepEqual(empty.failed, [{ url: `${SITE}/broken`, status: 200 }]);
  const notes = emptyPostNotes(empty, urls.length, levels);
  assert.equal(notes[0].text, '1 post listed in the feed no longer exists on the site; skipped: gone.');
  assert.equal(notes[1].level, 'problem');
});

test('feeds fetched before this run started are named plainly; feeds fetched by this run are not', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bau-feeds-'));
  fs.mkdirSync(path.join(dir, 'feeds'));
  fs.writeFileSync(path.join(dir, '.ready'), '2026-11-05T10:44:42.000Z');
  fs.writeFileSync(path.join(dir, 'feeds', 'FETCHED-AT.txt'), '2026-11-04T19:40:37.797Z');
  assert.equal(feedsNote(dir, levels).text, 'Using the feeds from the A check at 4 Nov, 19:40; run A first for the latest.');
  fs.writeFileSync(path.join(dir, 'feeds', 'FETCHED-AT.txt'), '2026-11-05T10:50:00.000Z');
  assert.equal(feedsNote(dir, levels), null);
});

test('app-cli-compare prints JSON (compared 0) when the generator wrote no files', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'bau-empty-out-'));
  const script = path.resolve('..', 'Schema Tools', 'scripts', 'app-cli-compare.mjs');
  const r = spawnSync(process.execPath, [script, out, '--ignore-run-dates'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(parseCompare(r.stdout), { compared: 0, identical: 0, differing: [], new_files: [] });
});
