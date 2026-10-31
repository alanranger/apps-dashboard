/**
 * Step handlers for the Update-all runner. DRY RUN (default) works in a sandbox copy of the folders the
 * scripts use, and never writes live CSVs, the schema repo, the database or Squarespace. LIVE handlers are
 * not enabled yet: every step refuses to run live until Alan switches it on (see the parking lot).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const WEB = 'G:/Dropbox/alan ranger photography/Website Code';
export const SHARED = `${WEB}/alan-shared-resources`;
const SCHEMA_TOOLS = `${WEB}/Schema Tools`;
const { readCsvObjects, writeCsv } = await import(pathToFileURL(`${SCHEMA_TOOLS}/scripts/csv-builders/lib.mjs`).href);
const PY_ENV = { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', SCHEMA_TOOLS_DRY_RUN: '1', ALAN_SITE_GAP_SECONDS: '2' };

// ---------- runner-wide pacing for alanranger.com ----------
const SITE_STATE = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'AlanUpdateAllRunner', 'site-state.json');
const SITE_GAP_MS = 4000;
export const COOL_DOWN_MS = 30 * 60 * 1000;

export function readSiteState() {
  try { return JSON.parse(fs.readFileSync(SITE_STATE, 'utf8')); } catch { return {}; }
}
function writeSiteState(patch) {
  fs.mkdirSync(path.dirname(SITE_STATE), { recursive: true });
  fs.writeFileSync(SITE_STATE, JSON.stringify({ ...readSiteState(), ...patch }));
}
export const record429 = () => writeSiteState({ last429At: new Date().toISOString() });

/** Every runner request to alanranger.com goes through here: ≥4 s apart (across runs), 429s recorded. */
export async function siteFetch(url, opts = {}) {
  const wait = SITE_GAP_MS - (Date.now() - Date.parse(readSiteState().lastRequestAt || 0));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  writeSiteState({ lastRequestAt: new Date().toISOString() });
  const res = await fetch(url, opts);
  if (res.status === 429) record429();
  return res;
}

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
  copyDir(`${SHARED}/csv processed`, path.join(sb.shared, 'csv processed'), (e) => !/\.(bak|old)$/i.test(e.name) && e.name !== 'credentials');
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
  const lock = path.join(SHARED, 'csv', '.update-all.lock');
  counts.auto_sync = fs.existsSync(lock) && JSON.parse(fs.readFileSync(lock, 'utf8')).runId === ctx.runId ? 'paused (csv/.update-all.lock held by this run)' : 'NOT paused';
  if (counts.auto_sync === 'NOT paused') softOrHard('shared-resources auto-sync is not paused (csv/.update-all.lock missing)');
  const gate = await sh('node', ['scripts/faq-layout-fixtures.mjs'], { cwd: SCHEMA_TOOLS });
  counts.faq_fixture_gate = gate.code === 0 ? 'pass' : 'fail';
  if (gate.code !== 0) failures.push(`FAQ fixture gate failed: ${tail(gate.stdout + gate.stderr, 200)}`);
  const missing = missingSecrets();
  if (missing.length) failures.push(`missing secrets: ${missing.join(', ')}`);
  counts.site_status = await siteChecks(ctx, softOrHard, failures);
  return { status: failures.length ? 'fail' : (warnings.length ? 'warn' : 'ok'), counts, warnings, error: failures.join('; ') || null };
}

/** Cool-down since the last 429 seen by this PC, then the home page status (with 429 retries). */
async function siteChecks(ctx, softOrHard, failures) {
  const last429 = Date.parse(readSiteState().last429At || 0);
  if (Date.now() - last429 < COOL_DOWN_MS) softOrHard(`alanranger.com rate-limited this PC at ${new Date(last429).toISOString()} — cool-down is 30 min`);
  const site = await siteStatus(ctx.siteRetries ?? 4);
  if (site === 429) softOrHard('alanranger.com is rate limiting (429) after retries — wait before a live run');
  else if (site !== 200) failures.push(`alanranger.com returned ${site}`);
  return site;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';

/** Home page status; on 429 waits 60 s and retries (Squarespace rate limit). */
async function siteStatus(tries) {
  let status = 0;
  for (let i = 0; i < tries; i += 1) {
    status = await siteFetch('https://www.alanranger.com/', { headers: { 'User-Agent': UA } }).then((r) => r.status).catch(() => 0);
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

const BUILDERS = `${SCHEMA_TOOLS}/scripts/csv-builders`;
const DRYRUN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dryrun');

const FEED_CACHE = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'AlanCsvBuilders', 'feeds');

/** Fresh read-only feeds (site JSON paced 6 s; event items only when new; Commerce API) into a sandbox copy of the cache. */
async function refreshFeeds(sb) {
  const feeds = path.join(sb.root, 'feeds');
  fs.cpSync(FEED_CACHE, feeds, { recursive: true });
  for (const script of ['fetch-feeds.mjs', 'fetch-event-items.mjs', 'fetch-commerce-products.mjs']) {
    const r = await sh('node', [script], { cwd: BUILDERS, env: { CSV_BUILDERS_FEEDS: feeds }, timeoutMs: 30 * 60 * 1000 });
    if (r.code !== 0) return { error: `${script}: ${tail(r.stderr || r.stdout)}` };
  }
  return { feeds };
}

async function buildCsvs(ctx) {
  ensureDry(ctx);
  const sb = buildSandbox(ctx);
  const csv = path.join(sb.shared, 'csv');
  const fresh = await refreshFeeds(sb);
  if (fresh.error) return { status: 'fail', error: fresh.error };
  const env = { CSV_BUILDERS_OUT: csv, CSV_BUILDERS_LIVE_CSV: `${SHARED}/csv`, CSV_BUILDERS_FEEDS: fresh.feeds };
  for (const script of ['build-exact.mjs', 'build-raw01-api.mjs']) {
    const r = await sh('node', [script], { cwd: BUILDERS, env });
    if (r.code !== 0) return { status: 'fail', error: `${script}: ${tail(r.stderr)}` };
  }
  const reportFile = path.join(sb.root, 'byte-compare-report.json');
  const cmp = await sh('node', ['byte-compare.mjs'], { cwd: BUILDERS, env: { ...env, EXACT_DIR: csv, REPORT: reportFile } });
  const counts = Object.fromEntries([...BUILT, 'raw-01-products-sqsp-export.csv'].map((f) => [f, lines(path.join(csv, f))]));
  const report = cmp.stdout.split('\n').filter((l) => l.includes('.csv:'));
  const warnings = report.filter((l) => !/wholeFile=true/.test(l)).map((l) => l.replace(/ formatting=.*?genuine=/, ' genuine=').slice(0, 220));
  const newLanding = (fs.readFileSync(path.join(csv, '08-landing-and-service-pages.csv'), 'utf8').match(/,NEW-suggested/g) || []).length;
  const needsAlan = newLanding ? [{ kind: 'new_08_pages_to_classify', count: newLanding, file: 'csv/08-landing-and-service-pages.csv (rows marked NEW-suggested)' }] : [];
  return { status: 'ok', counts: { ...counts, new_08_pages: newLanding }, needsAlan,
    warnings: warnings.length ? [`not byte-identical to the last export (content changed): ${warnings.length} files`, ...warnings] : [],
    outputs: [`${csv} (sandbox)`, reportFile] };
}

// ---------- 3 / 11. ingest (recording mock over a fresh read-only production snapshot) ----------
async function snapshotFor(ctx, sb) {
  const file = path.join(sb.root, 'prod-snapshot.json');
  if (fs.existsSync(file)) return file;
  const snap = {
    csv_metadata: await ctx.store.queryAll('csv_metadata?select=*'),
    page_entities: await ctx.store.queryAll('page_entities?select=id,url,kind,date_start,date_end,raw,csv_metadata_id'),
    v_events_for_chat: await ctx.store.query('v_events_for_chat?select=*&order=event_url.asc&limit=5000')
  };
  fs.writeFileSync(file, JSON.stringify(snap));
  return file;
}

async function dryIngest(ctx, types, reportName) {
  ensureDry(ctx);
  const sb = buildSandbox(ctx);
  const reportFile = path.join(sb.root, reportName);
  const r = await sh('node', ['--import', './register.mjs', 'run-dry-ingest.mjs'], { cwd: DRYRUN,
    env: { TEST_DIR: path.join(sb.shared, 'csv'), DRY_TYPES: types.join(','), REPORT: reportFile, DRY_SNAPSHOT: await snapshotFor(ctx, sb) } });
  if (r.code !== 0) return { status: 'fail', error: `dry ingest: ${tail(r.stderr)}` };
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  const counts = Object.fromEntries(report.map((t) => [t.csvType, `${t.rows_after} rows, ${t.new_rows_vs_manual} new, ${t.duplicates_test} dup`]));
  const dups = report.filter((t) => t.duplicates_test > 0).map((t) => t.csvType);
  const warnings = report.filter((t) => t.insert_payload_diffs.only_test).map((t) => `${t.csvType}: ${t.insert_payload_diffs.only_test} rows would change`);
  return { status: dups.length ? 'fail' : 'ok', counts, warnings, error: dups.length ? `duplicates in ${dups.join(', ')}` : null,
    outputs: [reportFile] };
}
/** A blog post, an event and a product from the sandbox CSVs: the step-2 scrape sample (paced, read-only GETs). */
function sampleUrls(csvDir) {
  const firstCell = (file, col) => {
    const rows = fs.readFileSync(path.join(csvDir, file), 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
    const idx = rows[0].split(',').indexOf(col);
    return rows.slice(1).map((r) => r.split(',')[idx]).find((v) => /^https:\/\/www\.alanranger\.com\//.test(v || ''));
  };
  return [firstCell('01-blog-posts.csv', 'Full Url'), firstCell('04-photography-services-courses-mentoring.csv', 'Full Url'),
    firstCell('05-photo-workshops-uk-landscape.csv', 'Full Url')].filter(Boolean);
}

/** Steps 2–4 + Export Mappings with the real handlers against the recording mock; export written into the sandbox. */
async function dryIngestSteps(ctx, sb) {
  const reportFile = path.join(sb.root, 'ingest-steps-2-4.json');
  const exportOut = path.join(sb.shared, 'csv processed', '05-event-product-mappings-latest.csv');
  const r = await sh('node', ['--import', './register.mjs', 'run-dry-ingest-steps.mjs'], { cwd: DRYRUN, timeoutMs: 10 * 60 * 1000,
    env: { DRY_SNAPSHOT: await snapshotFor(ctx, sb), SAMPLE_URLS: sampleUrls(path.join(sb.shared, 'csv')).join(','), EXPORT_OUT: exportOut, REPORT: reportFile } });
  if (r.code !== 0) return { error: `ingest steps 2–4: ${tail(r.stderr)}` };
  const rep = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  const live = fs.readFileSync(`${SHARED}/csv processed/05-event-product-mappings-latest.csv`, 'utf8').split(/\r?\n/).filter(Boolean);
  const fresh = fs.existsSync(exportOut) ? fs.readFileSync(exportOut, 'utf8').split(/\r?\n/).filter(Boolean) : [];
  const liveSet = new Set(live);
  const exp = rep.steps.find((s) => s.step.startsWith('export'));
  return { rep, reportFile, liveRows: live.length - 1, exportRows: exp?.rows ?? 0, rowsChanged: fresh.filter((l) => !liveSet.has(l)).length };
}

const ingestPreliminary = async (ctx) => {
  const r = await dryIngest(ctx, ['blog', 'course_events', 'workshop_events', 'course_products', 'workshop_products', 'landing_service_pages'], `update-all-${ctx.runId}-prelim.json`);
  if (r.status === 'fail') return r;
  const steps = await dryIngestSteps(ctx, buildSandbox(ctx));
  if (steps.error) return { ...r, status: 'fail', error: steps.error };
  const scraped = steps.rep.steps.filter((s) => s.step.startsWith('content'));
  const failedScrape = scraped.filter((s) => !s.ok).map((s) => s.url);
  const dupes = steps.rep.duplicate_page_entities;
  const counts = { ...r.counts, step2_scraped_sample: `${scraped.length - failedScrape.length}/${scraped.length}`, step2_duplicate_entities: dupes,
    step3_mappings_status: steps.rep.steps.find((s) => s.step.startsWith('mappings'))?.status, step4_finalize_status: steps.rep.steps.find((s) => s.step.startsWith('finalize'))?.status,
    export_rows: steps.exportRows, export_rows_live_file: steps.liveRows, export_rows_changed_vs_live: steps.rowsChanged,
    duplicates_already_in_db: steps.rep.duplicates_already_in_db.length };
  const warnings = [...(r.warnings || []), `steps 2–4 run with the real handlers on the recording mock; step 2 scraped a ${scraped.length}-URL sample`];
  if (failedScrape.length) warnings.push(`sample scrape failed: ${failedScrape.join(', ')}`);
  const inDb = steps.rep.duplicates_already_in_db;
  const needsAlan = inDb.length ? [{ kind: 'duplicate_page_entities_already_in_db', count: inDb.length, file: inDb.join('; ') }] : [];
  return { ...r, status: dupes ? 'fail' : (failedScrape.length ? 'warn' : 'ok'), counts, warnings, needsAlan, error: dupes ? `${dupes} duplicate page_entities created by the run` : null,
    outputs: [...(r.outputs || []), steps.reportFile, `${SHARED}/… sandbox csv processed/05-event-product-mappings-latest.csv`] };
};
const finalIngest = (ctx) => dryIngest(ctx, ['blog', 'course_events', 'workshop_events', 'course_products', 'workshop_products', 'landing_service_pages', 'product_schema'], `update-all-${ctx.runId}-final.json`);

// ---------- 4. reviews ----------
/** Google Business Profile fetch (free API) into the sandbox; OAuth files copied in for the fetch only, then removed. */
async function googleFetch(sb) {
  const creds = path.join(sb.shared, 'csv processed', 'credentials');
  copyDir(`${SHARED}/csv processed/credentials`, creds);
  try {
    const before = fs.statSync(path.join(sb.shared, 'csv', 'raw-03b-google-reviews.csv')).mtimeMs;
    const r = await sh('python', ['fetch-google-reviews.py'], { cwd: sb.scripts, env: PY_ENV, timeoutMs: 4 * 60 * 1000 });
    const after = fs.statSync(path.join(sb.shared, 'csv', 'raw-03b-google-reviews.csv')).mtimeMs;
    return { ok: r.code === 0 && after > before, rows: lines(path.join(sb.shared, 'csv', 'raw-03b-google-reviews.csv')), log: tail(r.stdout + r.stderr, 300) };
  } finally {
    fs.rmSync(creds, { recursive: true, force: true });
  }
}

/** combined = DB − excluded − gone from Google + business-level + star-only + new (Schema Tools reconcile script). */
async function reconcile(sb) {
  const r = await sh('python', ['reconcile-combined-vs-db.py'], { cwd: sb.scripts, env: PY_ENV });
  return r.code === 0 ? JSON.parse(r.stdout.trim().split('\n').pop()) : null;
}

function reconcileNote(x) {
  return `${x.combined} combined = ${x.db} in DB − ${x.excluded_dropped} excluded by Alan − ${x.removed_from_google} removed from Google (excluded)`
    + ` − ${x.gone_from_google} newly gone from Google + ${x.business_level} business-level + ${x.star_only} star-only (no text)`
    + ` + ${x.new_not_in_db} new${x.balanced ? '' : ' (DOES NOT BALANCE)'}`;
}

/** Fresh read-only product_reviews snapshot (with ids + exclusion reasons) for the reconcile script. */
async function reviewsSnapshot(ctx, sb) {
  const cols = ['id', 'source', 'source_review_id', 'reviewer_name', 'quote', 'product_slug', 'rating', 'review_date', 'is_excluded', 'exclude_reason'];
  const rows = await ctx.store.queryAll(`product_reviews?select=${cols.join(',')}`);
  writeCsv(path.join(sb.shared, 'csv processed', 'product-reviews-db-snapshot.csv'), cols,
    rows.map((r) => ({ ...r, is_excluded: r.is_excluded ? 'yes' : 'no', exclude_reason: r.exclude_reason || '' })));
}

const MAX_AUTO_EXCLUDE = 5;
const autoReason = (day) => `removed from Google (auto, ${day})`;

/**
 * Standing rule: a Google review no longer returned by the fetch is excluded; an automatic exclusion is lifted
 * when the review comes back. Live only, and only after a good fetch and a balanced reconcile.
 */
export async function applyRemovedFromGoogleRule(ctx, rec, fetchOk) {
  const plan = { exclude: rec?.to_exclude || [], unexclude: rec?.to_unexclude || [] };
  const blocked = !fetchOk || !rec?.balanced || plan.exclude.length > MAX_AUTO_EXCLUDE;
  if (ctx.mode === 'dry' || blocked) return { ...plan, applied: false, blocked };
  const day = new Date().toISOString().slice(0, 10);
  const patch = (id, body) => ctx.store.query(`product_reviews?id=eq.${id}`, { method: 'PATCH', body, prefer: 'return=minimal' });
  for (const r of plan.exclude) await patch(r.id, { is_excluded: true, exclude_reason: autoReason(day) });
  for (const r of plan.unexclude) await patch(r.id, { is_excluded: false, exclude_reason: null });
  return { ...plan, applied: true, blocked: false };
}

function reviewInfo(rec, rule) {
  const verb = rule.applied ? 'excluded' : 'would be excluded';
  return [
    ...(rec?.removed_names || []).map((n) => `${n}: removed from Google, excluded (info)`),
    ...rule.exclude.map((r) => `${r.name}: no longer on Google, ${verb} automatically (info)`),
    ...rule.unexclude.map((r) => `${r.name}: back on Google, automatic exclusion ${rule.applied ? 'lifted' : 'would be lifted'} (info)`)
  ];
}

async function reviews(ctx) {
  ensureDry(ctx);
  const sb = buildSandbox(ctx);
  const fetched = await googleFetch(sb);
  const r = await sh('python', ['merge-reviews.py'], { cwd: sb.scripts, env: PY_ENV });
  if (r.code !== 0) return { status: 'fail', error: `merge-reviews: ${tail(r.stdout + r.stderr)}` };
  const pendingFile = path.join(sb.shared, 'csv processed', '03b-google-pending-alan-review.csv');
  const pending = fs.existsSync(pendingFile) ? lines(pendingFile) : 0;
  await reviewsSnapshot(ctx, sb);
  const rec = await reconcile(sb);
  const rule = await applyRemovedFromGoogleRule(ctx, rec, fetched.ok);
  const warnings = [fetched.ok ? `Google Business Profile fetch OK (read-only, sandbox): ${fetched.rows} reviews` : `Google fetch failed — merge used the last fetched reviews: ${fetched.log}`];
  if (rec) warnings.push(reconcileNote(rec));
  if (rule.blocked && rule.exclude.length) warnings.push(`removed-from-Google rule not applied (fetch failed, unbalanced, or more than ${MAX_AUTO_EXCLUDE} at once)`);
  const needsAlan = pending ? [{ kind: 'held_reviews', count: pending, file: 'csv processed/03b-google-pending-alan-review.csv' }] : [];
  const otherGone = (rec?.gone_names || []).filter((n) => !n.startsWith('Google '));
  if (otherGone.length) needsAlan.push({ kind: 'reviews_missing_from_combined_still_in_db', count: otherGone.length, file: otherGone.join('; ') });
  const clean = fetched.ok && Boolean(rec?.balanced);
  return { status: clean ? 'ok' : 'warn', warnings: clean ? [] : warnings,
    counts: { google_fetched: fetched.ok ? fetched.rows : 'failed', combined_reviews: rec?.combined, db_reviews: rec?.db, google_pending_for_alan: pending,
      breakdown: warnings[1] || 'n/a', info: reviewInfo(rec, rule) },
    needsAlan, outputs: [`${sb.shared}/csv processed/03 – combined_product_reviews.csv (sandbox)`] };
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
  if (counts.faq_unknown) record429();
  const unknownNeeds = counts.faq_unknown ? [{ kind: 'faq_unknown_after_retry', count: counts.faq_unknown, file: 'outputs/schema/products/faq-fetch-status.json' }] : [];
  return { status: failed.length ? 'fail' : (counts.faq_unknown ? 'warn' : 'ok'), counts, error: failed.length ? `${failed.join(', ')} failed` : null, needsAlan: unknownNeeds,
    warnings: counts.faq_unknown ? [`${counts.faq_unknown} product FAQs still unknown after one paced retry — live FAQ kept`] : [],
    outputs: [`${sb.shared}/outputs/schema/products (sandbox)`, `${out07} (sandbox)`] };
}

// ---------- 6 / 7 / 9. Schema Tools app generators via scripts/app-cli.mjs (same functions, output into the sandbox) ----------
function appCliArgs(command, sb, out) {
  const args = ['scripts/app-cli.mjs', command, '--out', out, '--csv', path.join(sb.shared, 'csv')];
  const mappings = path.join(sb.shared, 'csv processed', '05-event-product-mappings-latest.csv');
  return command === 'event-posts' ? [...args, '--mappings', mappings] : args;
}

/** P5: landings stay report-only in LIVE runs until Alan approves the generator output against the hosted files. */
export const LANDINGS_REPORT_ONLY = true;

/** Landings: every difference against the hosted files, tied to its live source (scripts/landing-diff-explain.mjs). */
async function landingsReport(out, report, diff, reportOnly) {
  const file = path.join(out, 'landing-diff-explain.json');
  const r = await sh('node', ['scripts/landing-diff-explain.mjs', out, '--json', file], { cwd: SCHEMA_TOOLS });
  if (r.code !== 0) return { status: 'fail', error: `landing-diff-explain: ${tail(r.stderr || r.stdout)}` };
  const ex = JSON.parse(fs.readFileSync(file, 'utf8'));
  const lines = ex.rows.filter((row) => row.notes.length).map((row) => `${row.file}: ${row.notes.join(' | ')}`);
  return { status: ex.unexplained.length ? 'warn' : 'ok',
    counts: { live_mode: reportOnly ? 'report-only (P5)' : 'live', compared: ex.files, unexplained: ex.unexplained.length, files_written: report.files_written, seconds: report.seconds },
    warnings: [`${reportOnly ? 'report-only in LIVE until Claude approves: ' : ''}${lines.length} of ${ex.files} hosted landing files differ, each explained by a live source (list below / landing-diff-explain.json)`, ...lines],
    outputs: [`${out} (sandbox)`, file, path.join(out, 'compare.json')] };
}

const appCliStep = (command) => async (ctx) => {
  ensureDry(ctx);
  const sb = buildSandbox(ctx);
  const out = path.join(sb.root, 'app-cli', command);
  if (command === 'landings') {
    const rating = await sh('node', ['scripts/build-business-rating.mjs', '--out', path.join(out, 'alan-shared-resources', 'outputs', 'schema', 'business-rating-LATEST.json')], { cwd: SCHEMA_TOOLS });
    if (rating.code !== 0) return { status: 'fail', error: `business rating: ${tail(rating.stderr || rating.stdout)}` };
  }
  const run = await sh('node', appCliArgs(command, sb, out), { cwd: SCHEMA_TOOLS, env: { ALAN_SITE_GAP_SECONDS: '2' }, timeoutMs: 30 * 60 * 1000 });
  if (run.code !== 0) return { status: 'fail', error: `app-cli ${command}: ${tail(run.stderr || run.stdout)}` };
  const cmp = await sh('node', ['scripts/app-cli-compare.mjs', out, '--ignore-run-dates'], { cwd: SCHEMA_TOOLS });
  const diff = JSON.parse(cmp.stdout.slice(cmp.stdout.indexOf('{')));
  fs.writeFileSync(path.join(out, 'compare.json'), JSON.stringify(diff, null, 2));
  const report = JSON.parse(fs.readFileSync(path.join(out, 'app-cli-report.json'), 'utf8'));
  const changed = [...diff.differing.map((d) => d.file || d), ...diff.new_files];
  const reportOnly = command === 'landings' && LANDINGS_REPORT_ONLY;
  if (command === 'landings') return landingsReport(out, report, diff, reportOnly);
  return { status: 'ok', counts: { ...(reportOnly ? { live_mode: 'report-only (P5)' } : {}), files_written: report.files_written, compared: diff.compared, byte_identical: diff.identical, identical_except_run_dates: diff.identical_except_run_dates || 0, would_change: changed.length, seconds: report.seconds },
    warnings: changed.length ? [`${reportOnly ? 'report-only in LIVE until approved: ' : 'would deploy '}${changed.length} files that differ from alanranger-schema (see the compare in the sandbox), e.g. ${changed.slice(0, 3).join(', ')}`] : [],
    outputs: [`${out} (sandbox)`, path.join(out, 'compare.json')] };
};

// ---------- 8. blog posts: new or changed only (body-hash gate) ----------
const sha = (s) => crypto.createHash('sha256').update(String(s ?? '')).digest('hex').slice(0, 16);

/** Per post: feed updatedOn, a hash of the feed body and a hash of its 01-blog-posts row (title, tags, image…). */
export function blogManifest(feedItems, rows01) {
  const meta = new Map(rows01.map((r) => [r['Full Url'], sha(JSON.stringify(r))]));
  return Object.fromEntries(feedItems.map((i) => {
    const url = `https://www.alanranger.com${i.fullUrl}`;
    return [url, { updatedOn: i.updatedOn, bodyHash: sha(i.body), metaHash: meta.get(url) || null }];
  }));
}

/** A post regenerates only when it is new or its body / 01 row hash changed; an updatedOn bump alone is held by the gate. */
export function postsToRegenerate(current, baseline) {
  const out = { fresh: [], changed: [], touchedOnly: [] };
  for (const [url, c] of Object.entries(current)) {
    const b = baseline[url];
    if (!b) out.fresh.push(url);
    else if (b.bodyHash !== c.bodyHash || b.metaHash !== c.metaHash) out.changed.push(url);
    else if (b.updatedOn !== c.updatedOn) out.touchedOnly.push(url);
  }
  return out;
}

/** Dry-run stand-in until the first live run writes blogs-manifest.json: 01 rows from the last export, bodies assumed unchanged. */
function exportBaseline(current) {
  const rows = readCsvObjects(`${SHARED}/csv/01-blog-posts.csv`).rows;
  const meta = new Map(rows.map((r) => [r['Full Url'], sha(JSON.stringify(r))]));
  return Object.fromEntries(Object.entries(current).filter(([url]) => meta.has(url)).map(([url, c]) => [url, { ...c, metaHash: meta.get(url) }]));
}

async function blogPosts(ctx) {
  ensureDry(ctx);
  const sb = buildSandbox(ctx);
  const manifestFile = path.join(sb.shared, 'outputs', 'schema', 'blogs-manifest.json');
  const live = `${SHARED}/outputs/schema/blogs-manifest.json`;
  const feed = JSON.parse(fs.readFileSync(path.join(sb.root, 'feeds', 'blog-on-photography.json'), 'utf8')).items || [];
  const current = blogManifest(feed, readCsvObjects(path.join(sb.shared, 'csv', '01-blog-posts.csv')).rows);
  const firstRun = !fs.existsSync(live);
  const baseline = firstRun ? exportBaseline(current) : JSON.parse(fs.readFileSync(live, 'utf8')).posts || {};
  const r = postsToRegenerate(current, baseline);
  const list = [...r.fresh, ...r.changed];
  fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
  fs.writeFileSync(manifestFile, JSON.stringify({ generatedAt: new Date().toISOString(), posts: current }, null, 2));
  const listFile = path.join(sb.root, 'blog-posts-to-regenerate.csv');
  fs.writeFileSync(listFile, ['url', ...list].join('\n'));
  const slugs = list.map((u) => u.split('/').pop()).join(', ');
  return { status: 'ok', counts: { posts: feed.length, new: r.fresh.length, changed: r.changed.length, updated_on_only_held_by_gate: r.touchedOnly.length,
    would_regenerate: list.length, baseline: firstRun ? 'last 01 export (no blogs-manifest.json yet)' : 'blogs-manifest.json' },
    warnings: list.length ? [`would regenerate ${list.length} posts (paced), then write blogs-manifest.json${firstRun ? ' for the first time' : ''}: ${slugs}`] : [],
    outputs: [`${manifestFile} (sandbox)`, listFile] };
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

// ---------- 13. ① full audit (Traditional SEO render → broken links), advanced by the */5 trad-seo-render-tick cron ----------
const RENDER_API = 'https://ai-geo-audit.vercel.app/api/aigeo/traditional-seo-render';
const AUDIT_POLL_MS = 60 * 1000;
const AUDIT_MAX_MS = 180 * 60 * 1000;

/** Live only: start (or join) the full ① run and wait until render and broken links are both finished. */
async function liveAudit() {
  const start = await fetch(RENDER_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'start', source: 'trad_seo' }) }).then((r) => r.json());
  if (!start.ok) return { status: 'fail', error: `① start: ${start.error || 'failed'}` };
  for (const t0 = Date.now(); Date.now() - t0 < AUDIT_MAX_MS;) {
    await new Promise((r) => setTimeout(r, AUDIT_POLL_MS));
    const g = await fetch(`${RENDER_API}?runId=${start.run_id}`).then((r) => r.json()).catch(() => null);
    const status = g?.run?.status;
    if (status && !['running', 'started'].includes(status)) {
      const pending = (g.pages || []).length - (g.broken || []).length;
      if (status !== 'done' && status !== 'finished') return { status: 'warn', counts: { run_id: start.run_id, run_status: status }, warnings: [`① ended ${status}`] };
      if (pending <= 0) return { status: 'ok', counts: { run_id: start.run_id, pages: g.pages.length, broken_checked: g.broken.length } };
    }
  }
  return { status: 'warn', counts: { run_id: start.run_id }, warnings: ['① still running after 3 h: left to the render cron'] };
}

async function audit(ctx) {
  if (ctx.includeAudit === false) {
    return { status: 'skipped', counts: { include_audit: false, info: ['① full audit not selected for this run (Monday ① runs as usual)'] }, warnings: ['skipped — not selected'] };
  }
  const monday = new Date().getUTCDay() === 1;
  const running = await query(ctx, 'fault_monitor_runs?select=id,status&status=in.(running,started)&limit=1');
  const counts = { monday_utc: monday, audit_already_running: running?.length || 0 };
  if (ctx.mode === 'dry') {
    return { status: 'skipped', counts, warnings: [`① simulated in dry run (no requests). Live: POST ${RENDER_API} {action:'start', source:'trad_seo'}, then wait on fault_monitor_runs (render, then broken links; the */5 cron advances it)`] };
  }
  if (monday) return { status: 'fail', counts, error: 'never on a Monday: the Monday cron runs ①' };
  if (counts.audit_already_running) return { status: 'warn', counts, warnings: ['① is already running: not started again'] };
  return liveAudit();
}

/** Tally of all 14 steps, counting this summary step itself as ok (the page uses the same rule). */
async function summary(ctx) {
  const others = ctx.steps.filter((s) => s.step_id !== 'summary');
  const tally = [...others, { status: 'ok' }].reduce((m, s) => ({ ...m, [s.status]: (m[s.status] || 0) + 1 }), {});
  const info = others.flatMap((s) => s.counts?.info || []);
  await ctx.store?.updateRun?.(ctx.runId, { summary: { tally, info, steps: ctx.steps.map((s) => ({ id: s.step_id, status: s.status, counts: s.counts })) } });
  return { status: 'ok', counts: { ...tally, info } };
}

export const HANDLERS = {
  preflight, build_csvs: buildCsvs, ingest_preliminary: ingestPreliminary, reviews, product_schema: productSchema,
  event_posts: appCliStep('event-posts'), blog_index: appCliStep('blog-index'),
  blog_posts: blogPosts, landing_pages: appCliStep('landings'),
  deploy, final_ingest: finalIngest, export_09: export09,
  audit,
  summary
};
