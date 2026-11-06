import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { blogFilesManifest, blogPublishSet, BLOG_FILES } from '../../runner/steps.mjs';

test('blog-files lists only posts that have a _howto / _faq file (product FAQs ignored)', () => {
  const m = blogFilesManifest([
    'a_blogposting.json', 'a_howto.json', 'a_faq.json',
    'b_blogposting.json', 'b_faq.json',
    'c_blogposting.json',
    'kit_schema.json', 'kit_faq.json'
  ]);
  assert.deepEqual(m, { howto: ['a'], faq: ['a', 'b'] });
});

function sandbox(repoFiles, newFiles) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bau-f-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  repoFiles.forEach(([f, body]) => fs.writeFileSync(path.join(repo, f), body));
  const cmp = path.join(root, 'app-cli', 'blog-posts');
  fs.mkdirSync(cmp, { recursive: true });
  fs.writeFileSync(path.join(cmp, 'compare.json'), JSON.stringify({ differing: [], new_files: newFiles }));
  return { sb: { root }, repo };
}

test('F publishes blog-files.json with a new HowTo post, and not when nothing changed', () => {
  const { sb, repo } = sandbox([['a_blogposting.json', '{}'], ['a_howto.json', '{}']], ['b_blogposting.json', 'b_howto.json']);
  const first = blogPublishSet(sb, repo);
  assert.ok(first.publish.includes(BLOG_FILES));
  const written = JSON.parse(fs.readFileSync(path.join(sb.root, 'app-cli', 'blog-index', 'alanranger-schema', BLOG_FILES), 'utf8'));
  assert.deepEqual(written.howto, ['a', 'b']);

  fs.copyFileSync(path.join(sb.root, 'app-cli', 'blog-index', 'alanranger-schema', BLOG_FILES), path.join(repo, BLOG_FILES));
  ['b_blogposting.json', 'b_howto.json'].forEach((f) => fs.writeFileSync(path.join(repo, f), '{}'));
  fs.writeFileSync(path.join(sb.root, 'app-cli', 'blog-posts', 'compare.json'), JSON.stringify({ differing: [], new_files: [] }));
  assert.ok(!blogPublishSet(sb, repo).publish.includes(BLOG_FILES));
});
