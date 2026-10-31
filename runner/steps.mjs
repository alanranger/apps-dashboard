/**
 * Step handlers for the Update-all runner. DRY RUN (default) works in a sandbox copy of the folders the
 * scripts use, and never writes live CSVs, the schema repo, the database or Squarespace. LIVE handlers are
 * not enabled yet: every step refuses to run live until Alan switches it on (see the parking lot).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const WEB = 'G:/Dropbox/alan ranger photography/Website Code';
export const SHARED = `${WEB}/alan-shared-resources`;
const SCHEMA_TOOLS = `${WEB}/Schema Tools`;
const PILOT = 'C:/Users/alan/Google Drive/Claude shared resources/Cursor Outputs for Claude/PILOT-2026-10-31-test-csvs';
const PY_ENV = { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', SCHEMA_TOOLS_DRY_RUN: '1' };

export function sh(cmd, args, { cwd, env = {}, timeoutMs = 15 * 60 * 1000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, windowsHide: true });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: String(e) }); });
  });
}

const tail = (s, n = 400) => String(s || '').slice(-n);
const ensureDry = (ctx) => { if (ctx.mode !== 'dry') throw new Error('LIVE mode is not enabled for this step yet'); };
/** Data rows in a CSV (quote-aware: multi-line cells count once). */
export function csvRows(text) {
  let rows = 0; let q = false; let content = false;
  for (const c of text) {
    if (c === '"') q = !q;
    if (!q && c === '\n') { if (content) rows += 1; content = false; } else if (c !== '\r') content = true;
  }
  return Math.max(0, rows + (content ? 1 : 0) - 1);
}
const lines = (file) => csvRows(fs.readFileSync(file, 'utf8'));

/** Sandbox mirror: <root>/Schema Tools/scripts and <root>/alan-shared-resources/{csv,csv processed,outputs/...}. */
export function sandboxFor(ctx) {
  const root = path.join(ctx.sandboxBase || path.join(os.tmpdir(), 'update-all'), String(ctx.runId));
  return { root, scripts: path.join(root, 'Schema Tools', 'scripts'), shared: path.join(root, 'alan-shared-resources') };
}

function copyDir(src, dest, filter = () => true) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (!filter(e)) continue;
    const s = path.join(src, e.name); const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d, filter); else fs.copyFileSync(s, d);
  }
}

function buildSandbox(ctx) {
  const sb = sandboxFor(ctx);
  if (fs.existsSync(path.join(sb.root, '.ready'))) return sb;
  copyDir(`${SCHEMA_TOOLS}/scripts`, sb.scripts, (e) => !['__pycache__', 'node_modules'].includes(e.name));
  copyDir(`${SHARED}/csv`, path.join(sb.shared, 'csv'), (e) => e.name !== 'archive');
  copyDir(`${SHARED}/csv processed`, path.join(sb.shared, 'csv processed'), (e) => !/\.(bak|old)$/i.test(e.name));
  copyDir(`${SHARED}/outputs/schema/products`, path.join(sb.shared, 'outputs', 'schema', 'products'));
  fs.mkdirSync(path.join(sb.shared, 'outputs', 'reports'), { recursive: true });
  fs.writeFileSync(path.join(sb.root, '.ready'), new Date().toISOString());
  return sb;
}

// ---------- 1. pre-flight ----------
async function query(ctx, pathAndQuery) {
  return ctx.store?.query ? ctx.store.query(pathAndQuery) : [];
}

async function preflight(ctx) {
  const warnings = []; const failures = []; const counts = {};
  const softOrHard = (msg) => (ctx.mode === 'dry' ? warnings : failures).push(msg);
  if (new Date().getUTCDay() === 1) softOrHard('Monday (UTC): the Monday full refresh is running');
  const running = await query(ctx, 'fault_monitor_runs?select=id,status,last_tick_at&status=in.(running,started)&order=last_tick_at.desc&limit=1');
  if (running?.length) softOrHard(`① audit run ${running[0].id} is in progress`);
  const task = await sh('powershell', ['-NoProfile', '-Command', "(Get-ScheduledTask -TaskName 'AlanSharedResourcesAutoSync').State"]);
  counts.auto_sync_task = task.stdout.trim() || 'unknown';
  if (counts.auto_sync_task !== 'Disabled') softOrHard(`shared-resources auto-sync is ${counts.auto_sync_task}, not paused`);
  const gate = await sh('node', ['scripts/faq-layout-fixtures.mjs'], { cwd: SCHEMA_TOOLS });
  counts.faq_fixture_gate = gate.code === 0 ? 'pass' : 'fail';
  if (gate.code !== 0) failures.push(`FAQ fixture gate failed: ${tail(gate.stdout + gate.stderr, 200)}`);
  const missing = missingSecrets();
  if (missing.length) failures.push(`missing secrets: ${missing.join(', ')}`);
  const site = await siteStatus(ctx.siteRetries ?? 4);
  counts.site_status = site;
  if (site === 429) softOrHard('alanranger.com is rate limiting (429) after retries — wait before a live run');
  else if (site !== 200) failures.push(`alanranger.com returned ${site}`);
  return { status: failures.length ? 'fail' : (warnings.length ? 'warn' : 'ok'), counts, warnings, error: failures.join('; ') || null };
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';

/** Home page status; on 429 waits 60 s and retries (Squarespace rate limit). */
async function siteStatus(tries) {
  let status = 0;
  for (let i = 0; i < tries; i += 1) {
    status = await fetch('https://www.alanranger.com/', { headers: { 'User-Agent': UA } }).then((r) => r.status).catch(() => 0);
    if (status !== 429) return status;
    if (i < tries - 1) await new Promise((r) => setTimeout(r, 60000));
  }
  return status;
}

const SECRETS = [
  [`${WEB}/Chat AI Bot/.env.local`, ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']],
  [`${WEB}/AI GEO Audit/.env.local`, ['SQUARESPACE_API_KEY_CURSOR']],
  [`${WEB}/apps-dashboard/.env.local`, ['MC_SUPABASE_URL', 'MC_SUPABASE_SERVICE_KEY']]
];
function missingSecrets() {
  return SECRETS.flatMap(([file, keys]) => {
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    return keys.filter((k) => !new RegExp(`^${k}=.+`, 'm').test(text)).map((k) => `${path.basename(path.dirname(file))}:${k}`);
  });
}

// ---------- 2. build CSVs ----------
const BUILT = ['01-blog-posts.csv', '02-beginners-photography-lessons.csv', '03-photographic-workshops-near-me.csv',
  '04-photography-services-courses-mentoring.csv', '05-photo-workshops-uk-landscape.csv', '08-landing-and-service-pages.csv'];

async function buildCsvs(ctx) {
  ensureDry(ctx);
  const sb = buildSandbox(ctx);
  const a = await sh('node', ['scripts/build-exact.mjs'], { cwd: PILOT });
  if (a.code !== 0) return { status: 'fail', error: `build-exact: ${tail(a.stderr)}` };
  const b = await sh('node', ['scripts/build-raw01-api.mjs'], { cwd: PILOT, env: { CARRY_HIDDEN_CATEGORIES: '1' } });
  if (b.code !== 0) return { status: 'fail', error: `build-raw01-api: ${tail(b.stderr)}` };
  const csv = path.join(sb.shared, 'csv');
  for (const f of BUILT) fs.copyFileSync(path.join(PILOT, 'test-csvs-exact', f), path.join(csv, f));
  fs.copyFileSync(path.join(PILOT, 'test-csvs-exact-api-carry', 'raw-01-products-sqsp-export.csv'), path.join(csv, 'raw-01-products-sqsp-export.csv'));
  const cmp = await sh('node', ['scripts/byte-compare.mjs'], { cwd: PILOT, env: { EXACT_DIR: csv, REPORT: `byte-compare-update-all-${ctx.runId}.json` } });
  const counts = Object.fromEntries([...BUILT, 'raw-01-products-sqsp-export.csv'].map((f) => [f, lines(path.join(csv, f))]));
  const report = cmp.stdout.split('\n').filter((l) => l.includes('.csv:'));
  const warnings = report.filter((l) => !/wholeFile=true/.test(l)).map((l) => l.replace(/ formatting=.*?genuine=/, ' genuine=').slice(0, 220));
  return { status: 'ok', counts, warnings: warnings.length ? [`not byte-identical to the last export (content changed): ${warnings.length} files`, ...warnings] : [],
    outputs: [`${csv} (sandbox)`, `${PILOT}/byte-compare-update-all-${ctx.runId}.json`] };
}

// ---------- 3 / 11. ingest (recording mock) ----------
async function dryIngest(ctx, types, reportName) {
  ensureDry(ctx);
  const sb = buildSandbox(ctx);
  const r = await sh('node', ['--import', './register.mjs', 'run-dry-ingest.mjs'], { cwd: path.join(PILOT, 'dryrun'),
    env: { TEST_DIR: path.join(sb.shared, 'csv'), DRY_TYPES: types.join(','), REPORT: reportName } });
  if (r.code !== 0) return { status: 'fail', error: `dry ingest: ${tail(r.stderr)}` };
  const report = JSON.parse(fs.readFileSync(path.join(PILOT, 'dryrun', reportName), 'utf8'));
  const counts = Object.fromEntries(report.map((t) => [t.csvType, `${t.rows_after} rows, ${t.new_rows_vs_manual} new, ${t.duplicates_test} dup`]));
  const dups = report.filter((t) => t.duplicates_test > 0).map((t) => t.csvType);
  const warnings = report.filter((t) => t.insert_payload_diffs.only_test).map((t) => `${t.csvType}: ${t.insert_payload_diffs.only_test} rows would change`);
  return { status: dups.length ? 'fail' : 'ok', counts, warnings, error: dups.length ? `duplicates in ${dups.join(', ')}` : null,
    outputs: [`${PILOT}/dryrun/${reportName}`] };
}
const ingestPreliminary = async (ctx) => {
  const r = await dryIngest(ctx, ['blog', 'course_events', 'workshop_events', 'course_products', 'workshop_products', 'landing_service_pages'], `update-all-${ctx.runId}-prelim.json`);
  r.warnings = [...(r.warnings || []), 'ingest steps 2–4 and Export Mappings are browser-only today (parking lot P3); dry run covers step 1'];
  return r.status === 'ok' ? { ...r, status: 'warn' } : r;
};
const finalIngest = (ctx) => dryIngest(ctx, ['blog', 'course_events', 'workshop_events', 'course_products', 'workshop_products', 'landing_service_pages', 'product_schema'], `update-all-${ctx.runId}-final.json`);

// ---------- 4. reviews ----------
async function reviews(ctx) {
  ensureDry(ctx);
  const sb = buildSandbox(ctx);
  const r = await sh('python', ['merge-reviews.py'], { cwd: sb.scripts, env: PY_ENV });
  if (r.code !== 0) return { status: 'fail', error: `merge-reviews: ${tail(r.stdout + r.stderr)}` };
  const pendingFile = path.join(sb.shared, 'csv processed', '03b-google-pending-alan-review.csv');
  const pending = fs.existsSync(pendingFile) ? lines(pendingFile) : 0;
  const saved = (r.stdout.match(/Saved (\d+) reviews/) || [])[1];
  return { status: 'warn', counts: { combined_reviews: Number(saved || 0), google_pending_for_alan: pending },
    warnings: ['Google fetch skipped in dry run (paid API); merge used the last fetched reviews'],
    needsAlan: pending ? [{ kind: 'held_reviews', count: pending, file: 'csv processed/03b-google-pending-alan-review.csv' }] : [],
    outputs: [`${sb.shared}/csv processed/03 – combined_product_reviews.csv (sandbox)`] };
}

// ---------- 5. product schema ----------
async function productSchema(ctx) {
  ensureDry(ctx);
  const sb = buildSandbox(ctx);
  const clean = await sh('python', ['clean-products-csv.py'], { cwd: sb.scripts, env: PY_ENV });
  if (clean.code !== 0) return { status: 'fail', error: `clean-products: ${tail(clean.stdout + clean.stderr)}` };
  const out07 = path.join(sb.shared, 'csv', '07-product-schema-with-review-ratings.csv');
  const gen = await sh('python', ['generate-product-schema.py', '--write-07', out07], { cwd: sb.scripts, env: PY_ENV });
  if (gen.code !== 0) return { status: 'fail', error: `generator: ${tail(gen.stdout + gen.stderr)}` };
  const dates = await sh('python', ['check-review-dates.py'], { cwd: sb.scripts, env: PY_ENV });
  const homes = await sh('python', ['check-product-review-homes.py'], { cwd: sb.scripts, env: PY_ENV });
  const num = (re) => Number((gen.stdout.match(re) || [])[1] || 0);
  const counts = { faq_files: num(/Product FAQ files generated: (\d+)/), faq_unknown: num(/FAQ unknown[^:]*: (\d+)/), rows_07: lines(out07),
    review_dates: dates.code === 0 ? 'pass' : 'fail', review_homes: homes.code === 0 ? 'pass' : 'fail' };
  const failed = [dates.code && 'review dates guard', homes.code && 'review homes guard'].filter(Boolean);
  return { status: failed.length ? 'fail' : (counts.faq_unknown ? 'warn' : 'ok'), counts, error: failed.length ? `${failed.join(', ')} failed` : null,
    warnings: counts.faq_unknown ? [`${counts.faq_unknown} product FAQs unknown (fetch failed) — live FAQ kept`] : [],
    outputs: [`${sb.shared}/outputs/schema/products (sandbox)`, `${out07} (sandbox)`] };
}

// ---------- 8. blog posts: new or changed only ----------
export function changedPosts(sitemapXml, manifest) {
  const entries = [...sitemapXml.matchAll(/<url>\s*<loc>([^<]+)<\/loc>\s*(?:<lastmod>([^<]+)<\/lastmod>)?/g)]
    .map((m) => ({ url: m[1].trim(), lastmod: (m[2] || '').trim() }))
    .filter((e) => /\/blog-on-photography\/[^/]+$/.test(e.url));
  const fresh = entries.filter((e) => !manifest[e.url]);
  const changed = entries.filter((e) => manifest[e.url] && manifest[e.url].lastmod !== e.lastmod);
  return { entries, fresh, changed };
}

async function blogPosts(ctx) {
  ensureDry(ctx);
  const sb = buildSandbox(ctx);
  const manifestFile = path.join(sb.shared, 'outputs', 'schema', 'blogs-manifest.json');
  const live = `${SHARED}/outputs/schema/blogs-manifest.json`;
  const manifest = fs.existsSync(live) ? JSON.parse(fs.readFileSync(live, 'utf8')).posts || {} : {};
  const xml = await fetch('https://www.alanranger.com/sitemap.xml').then((r) => r.text());
  const { entries, fresh, changed } = changedPosts(xml, manifest);
  const posts = Object.fromEntries(entries.map((e) => [e.url, { lastmod: e.lastmod, bodyHash: manifest[e.url]?.bodyHash || null }]));
  fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
  fs.writeFileSync(manifestFile, JSON.stringify({ generatedAt: new Date().toISOString(), posts }, null, 2));
  const firstRun = !Object.keys(manifest).length;
  return { status: 'warn', counts: { posts: entries.length, new: fresh.length, changed: changed.length, would_regenerate: firstRun ? 0 : fresh.length + changed.length },
    warnings: [firstRun ? 'no live blogs-manifest.json yet: this run writes the baseline (sandbox), nothing would regenerate' : `${fresh.length + changed.length} posts would regenerate`,
      'body-hash gate and regeneration are not wired yet (parking lot P6)'],
    outputs: [`${manifestFile} (sandbox)`] };
}

// ---------- 10. deploy (dry: what would change) ----------
async function deploy(ctx) {
  ensureDry(ctx);
  const sb = buildSandbox(ctx);
  const src = path.join(sb.shared, 'outputs', 'schema', 'products');
  const repo = `${SCHEMA_TOOLS}/alanranger-schema`;
  const final04 = fs.readFileSync(path.join(sb.shared, 'csv processed', '04 – alanranger_product_schema_FINAL_WITH_REVIEW_RATINGS.csv'), 'utf8');
  const deploySet = [...new Set([...final04.matchAll(/[\w-]+_schema\.json/g)].map((m) => m[0]))]
    .flatMap((f) => [f, f.replace('_schema.json', '_faq.json')]).filter((f) => fs.existsSync(path.join(src, f)));
  const files = deploySet.filter((f) => fs.existsSync(path.join(repo, f)));
  const added = deploySet.filter((f) => !fs.existsSync(path.join(repo, f)));
  const changed = [...files.filter((f) => fs.readFileSync(path.join(src, f), 'utf8') !== fs.readFileSync(path.join(repo, f), 'utf8')), ...added];
  const cdn = await fetch(`https://schema.alanranger.com/products-manifest.json?t=${Date.now()}`).then((r) => r.status).catch(() => 0);
  return { status: cdn === 200 ? 'ok' : 'warn', counts: { deploy_set: deploySet.length, would_change: changed.length, new_files: added.length, cdn_manifest_status: cdn },
    warnings: changed.length ? [`would deploy ${changed.length} changed files, e.g. ${changed.slice(0, 3).join(', ')}`] : [],
    outputs: [] };
}

// ---------- 12. export 09 (dry: DB count only) ----------
async function export09(ctx) {
  ensureDry(ctx);
  const rows = await query(ctx, 'traditional_seo_target_keyword_overrides?select=id');
  const fileRows = lines(`${SHARED}/csv/09-url-target-keywords.csv`);
  return { status: 'ok', counts: { db_override_rows: rows?.length ?? 'n/a', csv_09_rows: fileRows }, warnings: [] };
}

const skipped = (why) => async () => ({ status: 'skipped', warnings: [why] });

async function summary(ctx) {
  const tally = ctx.steps.filter((s) => s.step_id !== 'summary').reduce((m, s) => ({ ...m, [s.status]: (m[s.status] || 0) + 1 }), {});
  await ctx.store?.updateRun?.(ctx.runId, { summary: { tally, steps: ctx.steps.map((s) => ({ id: s.step_id, status: s.status, counts: s.counts })) } });
  return { status: 'ok', counts: tally };
}

export const HANDLERS = {
  preflight, build_csvs: buildCsvs, ingest_preliminary: ingestPreliminary, reviews, product_schema: productSchema,
  event_posts: skipped('Event Posts bundle is Electron-only today (parking lot P4)'),
  blog_index: skipped('Blog Index is a Schema Tools UI step today (parking lot P5)'),
  blog_posts: blogPosts,
  landing_pages: skipped('Landing pages generator is a Schema Tools UI step today (parking lot P5)'),
  deploy, final_ingest: finalIngest, export_09: export09,
  audit: skipped('① audit simulated in dry run (no requests); live run calls the Vercel tick APIs (parking lot P7)'),
  summary
};
