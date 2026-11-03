#!/usr/bin/env node
/**
 * Live proof for one file stage (D / E / F / G) on a THROWAWAY clone of the schema repo (bare local remote, CDN off):
 * promote the stage's dry run through the real runner handler → exact-files commit = the dry run's publish list,
 * pushed, bytes = dry run → undo → tree identical. The live schema repo is never touched.
 *   node scripts/proof-bau-live-stage.mjs --stage G --run <dry run id> [--allow-unbuilt]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadEnv, supabaseStore } from '../runner/store.mjs';
import { HANDLERS, PUBLISH, REPO, sandboxFor } from '../runner/steps.mjs';

const { git, undoCommit } = await import(pathToFileURL('G:/Dropbox/alan ranger photography/Website Code/Schema Tools/scripts/lib/deploy-schemas.mjs').href);
const arg = (k) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : null);
const STAGE = arg('--stage');
const RUN = arg('--run');
const STEP = { D: 'publish_products', E: 'publish_events', F: 'publish_blogs', G: 'publish_landings' }[STAGE];
if (!STEP || !RUN) throw new Error('usage: --stage D|E|F|G --run <dry run id>');

const env = loadEnv(path.resolve('.env.local'));
const store = supabaseStore({ url: env.MC_SUPABASE_URL, key: env.MC_SUPABASE_SERVICE_KEY });
const [run] = await store.query(`update_all_runs?select=id,stage_results&id=eq.${RUN}`);
const dry = run.stage_results[STAGE];
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });
const must = (r, what) => { if (r.code !== 0) throw new Error(`${what}: ${r.stderr || r.stdout}`); return r.stdout.trim(); };
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

function throwaway() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `bau-live-${STAGE}-proof-`));
  const remote = path.join(root, 'remote.git');
  const work = path.join(root, 'work');
  must(git(root, ['clone', '-q', '--bare', REPO, remote]), 'bare clone');
  must(git(root, ['clone', '-q', '-c', 'core.autocrlf=false', remote, work]), 'clone');
  for (const [k, v] of [['user.email', 'proof@example.invalid'], ['user.name', `BAU live ${STAGE} proof`]]) must(git(work, ['config', k, v]), 'config');
  fs.mkdirSync(path.join(root, 'shared', 'outputs', 'schema'), { recursive: true });
  return { root, remote, work, shared: path.join(root, 'shared') };
}

const t = throwaway();
const ctx = { mode: 'live', store, runId: `proof-live-${STAGE}`, steps: [], schemaRepo: t.work, sharedRoot: t.shared, cdnCheck: false,
  promote: { stage: STAGE, run_id: RUN, sandbox: dry.sandbox, published: dry.published || [], removed: dry.removed || [] } };
try {
  check(`dry run ${RUN.slice(0, 8)} stage ${STAGE}: ok/warn with 0 unexplained removals`, ['ok', 'warn'].includes(dry.status) && dry.removals_unexplained === 0, `${dry.status}, ${dry.removals_unexplained}`);
  const baseTree = must(git(t.work, ['rev-parse', 'HEAD^{tree}']), 'tree');
  const out = await HANDLERS[STEP](ctx);
  const c = out.counts || {};
  const expected = [...(dry.published || []), ...(dry.removed || [])];
  const inCommit = c.commit ? must(git(t.work, ['diff', '--name-only', `${c.commit}^`, c.commit]), 'diff').split(/\r?\n/).filter(Boolean) : [];
  check(`Live ${STAGE}: one commit with exactly the dry run's ${expected.length} files`, c.commit && inCommit.length === expected.length && expected.every((f) => inCommit.includes(f)),
    c.commit ? `${inCommit.length} files, commit ${c.commit.slice(0, 8)}` : (out.notes || []).map((n) => n.text).join(' | '));
  check(`Live ${STAGE}: pushed to the (throwaway) remote`, c.commit && must(git(t.remote, ['rev-parse', 'main']), 'remote') === c.commit);
  const sb = sandboxFor({ promote: { sandbox: dry.sandbox } });
  const srcOf = (f) => PUBLISH[STEP].sources(sb).map((d) => path.join(d, f)).find((p) => fs.existsSync(p));
  check(`Live ${STAGE}: published bytes = the dry run's files`, (dry.published || []).every((f) => sha(path.join(t.work, f)) === sha(srcOf(f))));
  const undo = undoCommit({ repo: t.work, commit: c.commit, message: `Undo BAU ${STAGE} (proof)` });
  check(`Undo ${STAGE}: tree identical to before, and pushed`, must(git(t.work, ['rev-parse', 'HEAD^{tree}']), 'tree') === baseTree && must(git(t.remote, ['rev-parse', 'main']), 'remote') === undo.commit, baseTree);
} catch (e) {
  check('proof ran to the end', false, e.stack || e.message);
}
const pass = results.every((r) => r.ok);
fs.writeFileSync(`C:/TEMP/bau-live-${STAGE}-proof-LATEST.json`, JSON.stringify({ pass, stage: STAGE, run: RUN, throwaway: t.root, results }, null, 2));
console.log(JSON.stringify({ pass, results: results.map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok ? '' : ` :: ${r.detail}`}`) }, null, 2));
process.exitCode = pass ? 0 : 1;
