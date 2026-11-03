#!/usr/bin/env node
/**
 * Step-2 proof (no live site touched):
 *  1. the removal check on dry run a351ec0a's publish sets (D, E, F, G) — must flag G's 5 pages, Lake District
 *     and the E organizer, and nothing in F;
 *  2. stage F LIVE through the real runner handler, against a THROWAWAY clone of the schema repo (bare local
 *     remote, CDN check off): exact-files commit, pushed, bytes = dry run, then undo → tree identical;
 *     refusals: repo changed since the dry run, dirty repo, a stage whose live path isn't built.
 *   node scripts/proof-bau-live-f.mjs [--run a351ec0a-76c2-46b7-ba25-f4c7c4af3fc5]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadEnv, supabaseStore } from '../runner/store.mjs';
import { HANDLERS, PUBLISH, REPO, sandboxFor } from '../runner/steps.mjs';
import { publishRemovals } from '../runner/publish-live.mjs';

const SCHEMA_TOOLS = 'G:/Dropbox/alan ranger photography/Website Code/Schema Tools';
const { git, undoCommit } = await import(pathToFileURL(`${SCHEMA_TOOLS}/scripts/lib/deploy-schemas.mjs`).href);
const RUN = process.argv.includes('--run') ? process.argv[process.argv.indexOf('--run') + 1] : 'a351ec0a-76c2-46b7-ba25-f4c7c4af3fc5';

const env = loadEnv(path.resolve('.env.local'));
const store = supabaseStore({ url: env.MC_SUPABASE_URL, key: env.MC_SUPABASE_SERVICE_KEY });
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });
const must = (r, what) => { if (r.code !== 0) throw new Error(`${what}: ${r.stderr || r.stdout}`); return r.stdout.trim(); };
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

const [run] = await store.query(`update_all_runs?select=id,stage_results&id=eq.${RUN}`);
const steps = await store.query(`update_all_steps?select=step_id,details&run_id=eq.${RUN}`);
const sandbox = run.stage_results.F.sandbox;
const dryCtx = { mode: 'dry', promote: { sandbox }, steps, store };
const sb = sandboxFor(dryCtx);

async function removalProof() {
  const out = {};
  for (const id of ['publish_products', 'publish_events', 'publish_blogs', 'publish_landings']) {
    const def = PUBLISH[id];
    const set = def.set(sb, REPO);
    const r = await publishRemovals(def, sb, dryCtx, set.publish, REPO);
    out[def.stage] = { files: set.publish.length, removals: r.rows.length, unexplained: r.unexplained.length, files_unexplained: r.files_with_unexplained, rows: r.unexplained.map((x) => `${x.file}: ${x.what} [${x.node}]`) };
  }
  const g = out.G.files_unexplained;
  const five = ['photography-gift-vouchers', 'photo-editing-course-coventry', 'free-online-photography-course', 'gallery-image-portfolios', 'photography-mentoring-online-assignments'];
  check('removal check flags all 5 G pages', five.every((p) => g.includes(`${p}_landing_schema.json`)), g.join(', '));
  // Lake District: the offers were re-ordered (13–15 Nov 2026 → 12–14 Nov 2027, same SKU); the Jan 2027 offer has no
  // priceSpecification in the live file OR the new one — nothing is lost, so the check must NOT flag it.
  check('removal check does not flag Lake District (offers re-ordered, no priceSpecification lost)', !out.D.files_unexplained.includes('lake-district-photography-workshops-3-days-in-cumbria_schema.json'), out.D.files_unexplained.join(', '));
  check('removal check: D\'s 11 review reductions are explained (31 Oct re-homing)', out.D.unexplained === 0, out.D.rows.join(' | '));
  check('removal check flags the E organizer (lessons + workshops lists)', ['lessons-schema.json', 'workshops-schema.json'].every((f) => out.E.files_unexplained.includes(f)), out.E.rows.join(' | '));
  const eReviews = out.E.rows.filter((x) => /reviews/.test(x));
  check('E reviews (9.1 shared 04 rule): lavender + heather explained, garden (3 listed vs 04: 2) still flagged',
    eReviews.length === 2 && eReviews.every((x) => /garden-photography-workshop/.test(x)), eReviews.join(' | '));
  check('removal check: F has no unexplained removals', out.F.unexplained === 0, JSON.stringify(out.F));
  return out;
}

function throwaway() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bau-live-f-proof-'));
  const remote = path.join(root, 'remote.git');
  const work = path.join(root, 'work');
  must(git(root, ['clone', '-q', '--bare', REPO, remote]), 'bare clone');
  must(git(root, ['clone', '-q', '-c', 'core.autocrlf=false', remote, work]), 'clone');
  for (const [k, v] of [['user.email', 'proof@example.invalid'], ['user.name', 'BAU live F proof']]) must(git(work, ['config', k, v]), 'config');
  fs.mkdirSync(path.join(root, 'shared', 'outputs', 'schema'), { recursive: true });
  return { root, remote, work, shared: path.join(root, 'shared') };
}

const liveCtx = (t, extra = {}) => ({ mode: 'live', store, runId: 'proof-live-f', steps: [], schemaRepo: t.work, sharedRoot: t.shared, cdnCheck: false,
  promote: { stage: 'F', run_id: RUN, sandbox, published: run.stage_results.F.published, removed: run.stage_results.F.removed || [] }, ...extra });

async function liveProof() {
  const t = throwaway();
  const baseTree = must(git(t.work, ['rev-parse', 'HEAD^{tree}']), 'tree');
  const skipped = await HANDLERS.blog_posts(liveCtx(t));
  check('Live: the blog generator is not re-run (promoted)', skipped.status === 'skipped' && /Promoted from dry run/.test(skipped.plain), skipped.plain);
  const out = await HANDLERS.publish_blogs(liveCtx(t));
  const c = out.counts || {};
  const inCommit = c.commit ? must(git(t.work, ['diff', '--name-only', `${c.commit}^`, c.commit]), 'diff').split(/\r?\n/).filter(Boolean) : [];
  const expected = run.stage_results.F.published;
  check('Live F: one commit with exactly the dry run\'s 16 files', c.commit && inCommit.length === expected.length && expected.every((f) => inCommit.includes(f)), `${inCommit.length} files, commit ${String(c.commit).slice(0, 8)}`);
  check('Live F: pushed to the (throwaway) remote', must(git(t.remote, ['rev-parse', 'main']), 'remote') === c.commit);
  const srcOf = (f) => PUBLISH.publish_blogs.sources(sb).map((d) => path.join(d, f)).find((p) => fs.existsSync(p));
  check('Live F: published bytes = the dry run\'s files', expected.every((f) => sha(path.join(t.work, f)) === sha(srcOf(f))));
  check('Live F: blogs-manifest.json written for next month', fs.existsSync(path.join(t.shared, 'outputs', 'schema', 'blogs-manifest.json')), c.manifest);
  const undo = undoCommit({ repo: t.work, commit: c.commit, message: 'Undo BAU F (proof)' });
  check('Undo F: tree identical to before the publish, and pushed', must(git(t.work, ['rev-parse', 'HEAD^{tree}']), 'tree') === baseTree && must(git(t.remote, ['rev-parse', 'main']), 'remote') === undo.commit, baseTree);
  return t;
}

async function refusalProof(t) {
  const dirty = path.join(t.work, 'blog-schema.json');
  fs.appendFileSync(dirty, '\n');
  const r1 = await HANDLERS.publish_blogs(liveCtx(t)).catch((e) => ({ error: e.message }));
  check('Live refused when the repo has uncommitted changes', /uncommitted changes/.test(r1.error || ''), r1.error);
  must(git(t.work, ['checkout', '--', 'blog-schema.json']), 'tidy');
  const f = run.stage_results.F.published[1];
  const srcOf = (x) => PUBLISH.publish_blogs.sources(sb).map((d) => path.join(d, x)).find((p) => fs.existsSync(p));
  fs.copyFileSync(srcOf(f), path.join(t.work, f));
  must(git(t.work, ['commit', '-q', '-am', 'someone published one file since the dry run']), 'commit');
  const r2 = await HANDLERS.publish_blogs(liveCtx(t));
  check('Live refused when the schema repo changed since the dry run', r2.notes?.some((n) => n.level === 'problem' && /changed since dry run/.test(n.text)) && !r2.counts?.commit, r2.notes?.[0]?.text);
  const r3 = await HANDLERS.publish_products(liveCtx(t, { promote: { ...liveCtx(t).promote, stage: 'D' } }));
  check('Live refused for a stage whose live path is not built (D)', r3.notes?.some((n) => /not built yet/.test(n.text)), r3.notes?.[0]?.text);
}

let removals = null;
let t = null;
try {
  removals = await removalProof();
  t = await liveProof();
  await refusalProof(t);
} catch (e) {
  check('proof ran to the end', false, e.stack || e.message);
}
const pass = results.every((r) => r.ok);
fs.writeFileSync('C:/TEMP/bau-live-f-proof-LATEST.json', JSON.stringify({ pass, run: RUN, throwaway: t?.root, live_repo: REPO, removals, results }, null, 2));
console.log(JSON.stringify({ pass, results: results.map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok ? '' : ` :: ${r.detail}`}`) }, null, 2));
process.exitCode = pass ? 0 : 1;
