// H refused by left-over files (Claude/Alan 4 Nov): the clean check only looks at what the stage writes, an empty
// publish list never widens to the whole repo, the refusal is plain, F commits its blog baseline itself, and
// nothing under bookings/ is ever staged. Throwaway repos with a local bare remote only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { livePublish, blockedByChanges, leftBy } from '../../runner/publish-live.mjs';
import { PUBLISH } from '../../runner/steps.mjs';
import { undoStage } from '../../runner/undo-live.mjs';

const KW = 'csv/09-url-target-keywords.csv';
const BASELINE = 'outputs/schema/blogs-manifest.json';
const git = (cwd, args) => {
  const r = spawnSync('git', ['-c', 'core.quotePath=false', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const write = (root, rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
const staged = (repo) => git(repo, ['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
const committed = (repo, c) => git(repo, ['diff', '--name-only', `${c}^`, c]).split('\n').filter(Boolean);

/** A busy shared repo: H's and F's files committed, plus untracked customer data and working files like the real one. */
function sharedRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bau-guard-scope-'));
  const remote = path.join(root, 'remote.git');
  const repo = path.join(root, 'alan-shared-resources');
  git(root, ['init', '-q', '--bare', remote]);
  git(root, ['init', '-q', '-b', 'main', repo]);
  for (const [k, v] of [['user.email', 'test@example.invalid'], ['user.name', 'bau guard test'], ['core.autocrlf', 'false']]) git(repo, ['config', k, v]);
  write(repo, KW, 'url,keyword\na,1\n');
  write(repo, BASELINE, '{"posts":{"a":"1"}}\n');
  write(repo, 'csv/other.csv', 'x\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'init']);
  git(repo, ['remote', 'add', 'origin', remote]);
  git(repo, ['push', '-q', '-u', 'origin', 'main']);
  write(repo, 'bookings/2026-11.csv', 'name,email\nA,a@example.invalid\n');
  write(repo, 'errors.xlsx', 'xlsx');
  write(repo, 'docs/ACADEMY-COMPLETE-SPEC.md', '# spec');
  return { root, remote, repo, sandbox: path.join(root, 'sandbox') };
}

const hDef = (t) => ({ stage: 'H', what: 'keyword file', sources: () => [t.sandbox], filesScope: true, cdn: false });
const hCtx = (published) => ({ mode: 'live', runId: 'test-h', cdnCheck: false, promote: { stage: 'H', run_id: 'checked-h-0001', published, removed: [] } });
const noRemovals = { rows: [], unexplained: [], files_with_unexplained: [] };

test('H guard: untracked files outside H\'s paths pass, an empty publish list never widens to the whole repo', async () => {
  const t = sharedRepo();
  assert.equal(blockedByChanges(t.repo, [KW], 'H'), null, 'untracked bookings/, errors.xlsx, docs/ are not H\'s');
  assert.equal(blockedByChanges(t.repo, [], 'H'), null, 'empty list = only anything staged');
  write(t.repo, 'csv/other.csv', 'changed\n');
  assert.equal(blockedByChanges(t.repo, [KW], 'H'), null, 'a modified tracked file outside H\'s paths is not H\'s');
  const out = await livePublish(hDef(t), {}, hCtx([]), { publish: [], remove: [], removals: noRemovals, repo: t.repo });
  assert.equal(out.counts.commit, null);
  assert.match(out.plain, /Nothing new to publish for stage H/);
  assert.ok(!out.notes.some((n) => n.level === 'problem'), 'today\'s case: no refusal when the 09 file is unchanged');
});

test('H guard: a modified tracked file in H\'s paths refuses with the plain message, nothing written', async () => {
  const t = sharedRepo();
  write(t.repo, KW, 'url,keyword\na,edited by hand\n');
  write(t.sandbox, KW, 'url,keyword\na,2\n');
  const head = git(t.repo, ['rev-parse', 'HEAD']);
  const out = await livePublish(hDef(t), {}, hCtx([KW]), { publish: [KW], remove: [], removals: noRemovals, repo: t.repo });
  const problem = out.notes.find((n) => n.level === 'problem');
  assert.equal(problem.text, `Stage H wrote nothing: alan-shared-resources/${KW} has changes that are not committed. It was left by stage H's 09 export (or a manual edit).`);
  assert.match(problem.todo, /^commit that file in alan-shared-resources .*then click 2\. Publish live… on stage H again$/);
  assert.equal(git(t.repo, ['rev-parse', 'HEAD']), head, 'no commit');
  assert.equal(fs.readFileSync(path.join(t.repo, KW), 'utf8'), 'url,keyword\na,edited by hand\n', 'the hand edit is left alone');
});

test('H publish: commits exactly the 09 file, bookings/ is never staged or committed', async () => {
  const t = sharedRepo();
  write(t.sandbox, KW, 'url,keyword\na,2\n');
  const out = await livePublish(hDef(t), {}, hCtx([KW]), { publish: [KW], remove: [], removals: noRemovals, repo: t.repo });
  assert.ok(out.counts.commit, out.notes.map((n) => n.text).join(' | '));
  assert.deepEqual(committed(t.repo, out.counts.commit), [KW]);
  assert.equal(git(t.remote, ['rev-parse', 'main']), out.counts.commit, 'pushed');
  assert.deepEqual(staged(t.repo), []);
  assert.match(git(t.repo, ['status', '--porcelain', '--', 'bookings']), /^\?\? bookings\//, 'bookings/ still untracked');
});

test('the refusal names who left a file', () => {
  assert.match(leftBy(BASELINE), /stage F's live publish/);
  assert.match(leftBy('outputs/schema/blogs-manifest.prev-dce4225e.json'), /stage F's live publish/);
  assert.match(leftBy('csv processed/06-prune-report-latest.json'), /auto-sync/);
  assert.match(leftBy('csv/01-x.csv'), /outside the BAU runner/);
});

test('F live: the blog baseline is committed as its own commit; a dirty baseline refuses before anything is published; Undo reverses it', async () => {
  const t = sharedRepo();
  const def = PUBLISH.publish_blogs;
  const ctx = { mode: 'live', runId: 'test-f-0001', sharedRepo: t.repo, promote: { stage: 'F', run_id: 'checked-f-0001' } };
  write(t.sandbox, `shared/${BASELINE}`, '{"posts":{"a":"2"}}\n');
  const sb = { shared: path.join(t.sandbox, 'shared') };
  assert.equal(def.before(ctx), null, 'clean baseline: F may publish');
  const r = def.after(sb, ctx);
  assert.ok(r.manifest_commit);
  assert.deepEqual(committed(t.repo, r.manifest_commit), [BASELINE]);
  assert.equal(git(t.remote, ['rev-parse', 'main']), r.manifest_commit, 'pushed');
  assert.deepEqual(staged(t.repo), [], 'nothing left staged; bookings/ untouched');
  assert.equal(fs.readdirSync(path.join(t.repo, 'outputs', 'schema')).filter((f) => /\.prev-/.test(f)).length, 0, 'no .prev copy beside the file');

  write(t.repo, BASELINE, '{"posts":{"a":"left over"}}\n');
  const refused = def.before(ctx);
  assert.match(refused.notes[0].text, /^Stage F wrote nothing: alan-shared-resources\/outputs\/schema\/blogs-manifest\.json has changes that are not committed\. It was left by stage F's live publish/);
  git(t.repo, ['checkout', '--', BASELINE]);

  const undo = await undoStage('F', { run_id: 'test-f-0001', commit: null, manifest_commit: r.manifest_commit }, 'undo-f-0001', { repos: { shared: t.repo, schema: t.repo } });
  assert.ok(undo.manifest.commit);
  assert.equal(fs.readFileSync(path.join(t.repo, BASELINE), 'utf8'), '{"posts":{"a":"1"}}\n', 'baseline back to before the publish');
});

test('the real alan-shared-resources ignores bookings/, errors.xlsx, upload sites/ and has nothing under bookings/ staged (read-only)', () => {
  const repo = 'G:/Dropbox/alan ranger photography/Website Code/alan-shared-resources';
  for (const p of ['bookings/', 'errors.xlsx', 'upload sites/', 'outputs/schema/blogs-manifest.prev-dce4225e.json']) {
    assert.equal(spawnSync('git', ['check-ignore', '-q', p], { cwd: repo }).status, 0, `${p} is ignored`);
  }
  assert.equal(spawnSync('git', ['check-ignore', '-q', 'docs/ACADEMY-COMPLETE-SPEC.md'], { cwd: repo }).status, 1, 'docs/ left for Alan');
  assert.deepEqual(staged(repo).filter((f) => f.startsWith('bookings/')), []);
  assert.deepEqual(git(repo, ['ls-files', '--', 'bookings']), '', 'bookings/ was never committed');
});
