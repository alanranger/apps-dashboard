/**
 * Step handlers for the Update-all runner. DRY RUN (default) works in a sandbox copy of the folders the
 * scripts use, and never writes live CSVs, the schema repo, the database or Squarespace. LIVE handlers are
 * not enabled yet: every step refuses to run live until Alan switches it on (see the parking lot).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { coverage, coverageLine, TABS } from './coverage.mjs';
import { diff07 } from './diff-07.mjs';
import { applyChoices, heldItems, simulatedHeld } from './held-reviews.mjs';
import { publishRemovals, livePublish, removalNotes, removalCounts, removalDetails } from './publish-live.mjs';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const WEB = 'G:/Dropbox/alan ranger photography/Website Code';
export const SHARED = `${WEB}/alan-shared-resources`;
const SCHEMA_TOOLS = `${WEB}/Schema Tools`;
const { readCsvObjects, writeCsv, pathKey } = await import(pathToFileURL(`${SCHEMA_TOOLS}/scripts/csv-builders/lib.mjs`).href);
const { deletedBlogPosts, planDeletedPostCleanup } = await import(pathToFileURL(`${SCHEMA_TOOLS}/scripts/lib/stale-schema-cleanup.mjs`).href);
const { SITE_UA, retryAfterMs } = await import(pathToFileURL(`${SCHEMA_TOOLS}/scripts/lib/site-identity.mjs`).href);
export { retryAfterMs };
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
  if (res.status === 429) {
    record429();
    writeSiteState({ last429: { url, method: opts.method || 'GET', contextId: res.headers.get('x-contextid'), retryAfterMs: retryAfterMs(res.headers) } });
  }
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

// ---------- readable results: info (expected, nothing to do) / check (look at it, with what to do) / problem ----------
const note = (level, text, todo) => (todo ? { level, text, todo } : { level, text });
export const info = (text) => note('info', text);
export const check = (text, todo) => note('check', text, todo);
export const problem = (text, todo) => note('problem', text, todo);
/** Dry runs say what would happen; live runs say what did. */
export const verb = (ctx, dry, live) => (ctx.mode === 'live' ? live : dry);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
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
  // Live promotes a dry run: its sandbox IS that dry run's sandbox (the files the dry run reported).
  const root = ctx.promote?.sandbox || path.join(ctx.sandboxBase || path.join(os.tmpdir(), 'update-all'), String(ctx.runId));
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
  const checks = []; const failures = []; const counts = {};
  const softOrHard = (msg, todo) => (ctx.mode === 'dry' ? checks.push(check(msg, todo)) : failures.push(problem(msg, todo)));
  if (new Date().getUTCDay() === 1) softOrHard('It is Monday (UTC): the Monday full refresh is running', 'run on another day');
  const running = await query(ctx, 'fault_monitor_runs?select=id,status,last_tick_at&status=in.(running,started)&order=last_tick_at.desc&limit=1');
  if (running?.length) softOrHard(`① audit run ${running[0].id} is in progress`, 'wait for ① to finish');
  const lock = path.join(SHARED, 'csv', '.update-all.lock');
  counts.auto_sync = fs.existsSync(lock) && JSON.parse(fs.readFileSync(lock, 'utf8')).runId === ctx.runId ? 'paused (csv/.update-all.lock held by this run)' : 'NOT paused';
  if (counts.auto_sync === 'NOT paused') softOrHard('Shared-resources auto-sync is not paused', 'check csv/.update-all.lock on the PC');
  const gate = await sh('node', ['scripts/faq-layout-fixtures.mjs'], { cwd: SCHEMA_TOOLS });
  counts.faq_fixture_gate = gate.code === 0 ? 'pass' : 'fail';
  if (gate.code !== 0) failures.push(problem(`FAQ fixture gate failed: ${tail(gate.stdout + gate.stderr, 200)}`, 'fix the FAQ extractor before running'));
  const missing = missingSecrets();
  if (missing.length) failures.push(problem(`Missing keys on the PC: ${missing.join(', ')}`, 'add them to the .env.local files'));
  counts.site_status = await siteChecks(ctx, softOrHard, failures);
  const bad = failures.length || checks.length;
  return { counts, notes: [...failures, ...checks],
    plain: bad ? 'Pre-flight found something to look at (below).' : 'Pre-flight passed: not Monday, no ① running, auto-sync paused, FAQ gate passed, keys present, site up.',
    details: [`site status ${counts.site_status}`, `FAQ fixture gate ${counts.faq_fixture_gate}`, `auto-sync ${counts.auto_sync}`] };
}

/** Cool-down since the last 429 seen by this PC, then the home page status (with 429 retries). */
async function siteChecks(ctx, softOrHard, failures) {
  const last429 = Date.parse(readSiteState().last429At || 0);
  if (Date.now() - last429 < COOL_DOWN_MS) softOrHard(`alanranger.com rate-limited this PC at ${new Date(last429).toISOString()}`, 'wait for the 30-minute cool-down');
  const site = await siteStatus(ctx.siteRetries ?? 4);
  if (site === 429) softOrHard('alanranger.com is rate limiting (429) after retries', 'wait before a live run');
  else if (site !== 200) failures.push(problem(`alanranger.com returned ${site}`, 'check the site is up'));
  return site;
}

/** The same honest identity as the feed fetches (a fake Chrome UA from Node gets 429s: batch 8 diagnosis). */
export const UA = SITE_UA;

/** One lightweight check of the home page (HEAD, CDN-cached, no body). */
export const siteProbe = (url = 'https://www.alanranger.com/') => siteFetch(url, { method: 'HEAD', headers: { 'User-Agent': UA } });

/** Home page status; on 429 waits Retry-After (or 60 s, at most 10 min) and retries. */
async function siteStatus(tries) {
  let status = 0;
  for (let i = 0; i < tries; i += 1) {
    const res = await siteProbe().catch(() => null);
    status = res?.status || 0;
    if (status !== 429) return status;
    const wait = Math.min(retryAfterMs(res.headers) ?? 60000, 10 * 60 * 1000);
    if (i < tries - 1) await new Promise((r) => setTimeout(r, wait));
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

/** P16: Alan's saved 08 choices (bau_page_choices) as { pathKey: choice } for the builder. */
async function pageChoices(ctx, sb) {
  const rows = (await query(ctx, 'bau_page_choices?select=url,choice')) || [];
  const file = path.join(sb.root, '08-page-choices.json');
  fs.writeFileSync(file, JSON.stringify(Object.fromEntries(rows.map((r) => [pathKey(r.url), r.choice]))));
  return { file, count: rows.length };
}

/** Each page new in 06 that Alan hasn't classified: one Needs Alan item with a suggested type and three buttons. */
function newPageItems(csv) {
  const file = path.join(csv, '08-new-pages-pending.json');
  const pending = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { pending: [], excluded: [] };
  return { pending: pending.pending, excluded: pending.excluded,
    needsAlan: pending.pending.map((p) => ({ kind: 'new_08_page', count: 1, url: p.url, suggested: p.suggested, file: 'new page in 06: choose Service, Landing or Exclude' })) };
}

async function buildCsvs(ctx) {
  ensureDry(ctx);
  const sb = buildSandbox(ctx);
  const csv = path.join(sb.shared, 'csv');
  const fresh = await refreshFeeds(sb);
  if (fresh.error) return { notes: [problem(`Feed fetch failed: ${fresh.error}`, 'resume the run (fetches are retried)')] };
  const choices = await pageChoices(ctx, sb);
  const env = { CSV_BUILDERS_OUT: csv, CSV_BUILDERS_LIVE_CSV: `${SHARED}/csv`, CSV_BUILDERS_FEEDS: fresh.feeds, CSV_BUILDERS_08_CHOICES: choices.file,
    CSV_BUILDERS_SIMULATE_06: (ctx.simulateNew08 || []).join(',') };
  for (const script of ['build-exact.mjs', 'build-raw01-api.mjs']) {
    const r = await sh('node', [script], { cwd: BUILDERS, env });
    if (r.code !== 0) return { notes: [problem(`${script} failed: ${tail(r.stderr)}`, 'resume the run')] };
  }
  const reportFile = path.join(sb.root, 'byte-compare-report.json');
  const cmp = await sh('node', ['byte-compare.mjs'], { cwd: BUILDERS, env: { ...env, EXACT_DIR: csv, REPORT: reportFile } });
  const counts = Object.fromEntries([...BUILT, 'raw-01-products-sqsp-export.csv'].map((f) => [f, lines(path.join(csv, f))]));
  const changed = cmp.stdout.split('\n').filter((l) => l.includes('.csv:') && !/wholeFile=true/.test(l)).map((l) => l.replace(/ formatting=.*?genuine=/, ' genuine=').slice(0, 220));
  const pages = newPageItems(csv);
  const notes = [];
  if (changed.length) notes.push(info(`${plural(changed.length, 'CSV')} changed since the last export because the site content changed; ${verb(ctx, 'they would replace', 'they replaced')} the saved CSVs.`));
  if (pages.pending.length) notes.push(info(`${plural(pages.pending.length, 'new page')} found in 06, waiting for your choice under Needs Alan (no schema until you choose).`));
  return { counts: { ...counts, new_08_pages: pages.pending.length, excluded_by_choice: pages.excluded.length, saved_08_choices: choices.count }, needsAlan: pages.needsAlan, notes,
    plain: `${verb(ctx, 'Would rebuild', 'Rebuilt')} ${BUILT.length + 1} CSVs from Squarespace${changed.length ? `; ${changed.length} changed since the last export` : '; none changed'}.`,
    details: changed, outputs: [`${csv} (sandbox)`, reportFile] };
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
  if (r.code !== 0) return { notes: [problem(`Dry ingest failed: ${tail(r.stderr)}`, 'resume the run')], error: 'dry ingest failed' };
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  const counts = Object.fromEntries(report.map((t) => [t.csvType, `${t.rows_after} rows, ${t.new_rows_vs_manual} new, ${t.duplicates_test} dup`]));
  const dups = report.filter((t) => t.duplicates_test > 0).map((t) => t.csvType);
  const changes = report.filter((t) => t.insert_payload_diffs.only_test);
  const total = changes.reduce((n, t) => n + t.insert_payload_diffs.only_test, 0);
  const notes = dups.length ? [problem(`Duplicates would be created in ${dups.join(', ')}`, 'do not run live; tell Claude')] : [];
  if (total) notes.push(info(`${plural(total, 'database row')} ${verb(ctx, 'would change', 'changed')} because the CSVs changed; 0 duplicates.`));
  return { counts, notes, error: dups.length ? `duplicates in ${dups.join(', ')}` : null, rowsChanged: total,
    details: changes.map((t) => `${t.csvType}: ${t.insert_payload_diffs.only_test} rows ${verb(ctx, 'would change', 'changed')}`), outputs: [reportFile] };
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
  if (r.error) return r;
  const steps = await dryIngestSteps(ctx, buildSandbox(ctx));
  if (steps.error) return { ...r, notes: [problem(steps.error, 'resume the run')] };
  const scraped = steps.rep.steps.filter((s) => s.step.startsWith('content'));
  const failedScrape = scraped.filter((s) => !s.ok).map((s) => s.url);
  const dupes = steps.rep.duplicate_page_entities;
  const counts = { ...r.counts, step2_scraped_sample: `${scraped.length - failedScrape.length}/${scraped.length}`, step2_duplicate_entities: dupes,
    step3_mappings_status: steps.rep.steps.find((s) => s.step.startsWith('mappings'))?.status, step4_finalize_status: steps.rep.steps.find((s) => s.step.startsWith('finalize'))?.status,
    export_rows: steps.exportRows, export_rows_live_file: steps.liveRows, export_rows_changed_vs_live: steps.rowsChanged,
    duplicates_already_in_db: steps.rep.duplicates_already_in_db.length };
  const notes = [...r.notes];
  if (dupes) notes.push(problem(`${dupes} duplicate page entities would be created`, 'do not run live; tell Claude'));
  if (failedScrape.length) notes.push(check(`Sample page scrape failed: ${failedScrape.join(', ')}`, 'open the page; resume the run if it loads'));
  if (steps.rowsChanged) notes.push(info(`The event-product links file (05) ${verb(ctx, 'would change', 'changed')} in ${plural(steps.rowsChanged, 'row')} (events added or past events dropped).`));
  const inDb = steps.rep.duplicates_already_in_db;
  const needsAlan = inDb.length ? [{ kind: 'duplicate_page_entities_already_in_db', count: inDb.length, file: inDb.join('; ') }] : [];
  return { counts, notes, needsAlan,
    plain: `${verb(ctx, 'Would ingest', 'Ingested')} the CSVs into the chat database and ${verb(ctx, 'would save', 'saved')} the event-product links (05): ${plural(r.rowsChanged || 0, 'row')} changed, 0 duplicates.`,
    details: [...r.details, `steps 2–4 run with the real handlers ${verb(ctx, 'on the recording mock (no writes)', 'against the database')}; step 2 scraped a ${scraped.length}-URL sample`,
      `export rows ${steps.exportRows} (live file ${steps.liveRows}, ${steps.rowsChanged} changed)`],
    outputs: [...(r.outputs || []), steps.reportFile, `${SHARED}/… sandbox csv processed/05-event-product-mappings-latest.csv`] };
};

/** Final ingest (incl. product_schema from the new 07): what the run writes into the chat database. */
async function finalIngest(ctx) {
  const r = await dryIngest(ctx, ['blog', 'course_events', 'workshop_events', 'course_products', 'workshop_products', 'landing_service_pages', 'product_schema'], `update-all-${ctx.runId}-final.json`);
  if (r.error) return r;
  const written = ctx.mode === 'live' ? r.counts : null;
  return { ...r, counts: { ...r.counts, ...(written ? { written } : {}) },
    plain: `${verb(ctx, 'Would ingest', 'Ingested')} the CSVs again, including the new product schema (07): ${plural(r.rowsChanged || 0, 'row')} changed, 0 duplicates.` };
}

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
  await reviewsSnapshot(ctx, sb);
  const decided = await applyReviewChoices(ctx, sb);
  const r = await sh('python', ['merge-reviews.py'], { cwd: sb.scripts, env: PY_ENV });
  if (r.code !== 0) return { notes: [problem(`Review merge failed: ${tail(r.stdout + r.stderr)}`, 'resume the run')] };
  const held = heldReviewCards(ctx, sb);
  const pending = held.real;
  const rec = await reconcile(sb);
  const rule = await applyRemovedFromGoogleRule(ctx, rec, fetched.ok);
  const notes = reviewInfo(rec, rule).map(info);
  if (!fetched.ok) notes.push(check('The Google reviews fetch failed, so the merge used the last fetched reviews', 'resume the run later; tell Claude if it fails again'));
  if (rec && !rec.balanced) notes.push(check('The review totals do not balance (combined vs database)', 'tell Claude; see Details'));
  if (rule.blocked && rule.exclude.length) notes.push(check(`The removed-from-Google rule was not applied (fetch failed, unbalanced, or more than ${MAX_AUTO_EXCLUDE} at once)`, 'tell Claude'));
  const shadow = shadowSummary(sb);
  if (shadow) notes.push(info(shadow.line));
  if (decided.applied.length) notes.push(info(`${plural(decided.applied.length, 'held review')} you decided on the page ${verb(ctx, 'would be', 'were')} applied (${decided.overrides_added} new override rows).`));
  const needsAlan = [...held.items];
  const otherGone = (rec?.gone_names || []).filter((n) => !n.startsWith('Google '));
  if (otherGone.length) needsAlan.push({ kind: 'reviews_missing_from_combined_still_in_db', count: otherGone.length, file: otherGone.join('; ') });
  return { notes, needsAlan,
    counts: { google_fetched: fetched.ok ? fetched.rows : 'failed', combined_reviews: rec?.combined, db_reviews: rec?.db, google_pending_for_alan: pending,
      choices_applied: decided.applied.length, products_for_choice: held.products, info: reviewInfo(rec, rule), shadow_matcher: shadow?.summary || null },
    plain: `Fetched ${fetched.ok ? fetched.rows : 'no'} Google reviews and merged them with the frozen Trustpilot reviews: ${rec?.combined ?? '?'} reviews${pending ? `, ${pending} new held for you` : ', none new to decide'}.`,
    details: [rec ? reconcileNote(rec) : 'reconcile not run', fetched.ok ? `Google Business Profile fetch OK (read-only${ctx.mode === 'dry' ? ', sandbox' : ''})` : fetched.log],
    outputs: [`${sb.shared}/csv processed/03 – combined_product_reviews.csv (sandbox)`, path.join(sb.shared, 'outputs', 'reports', 'shadow-review-matcher-LATEST.json')] };
}

/** Alan's page choices for held reviews → 15 overrides (+ alias list) before the merge (dry: the sandbox copies). */
async function applyReviewChoices(ctx, sb) {
  const choices = ((await query(ctx, 'bau_review_choices?select=review_key,choice,product_slug,reason')) || []).filter((c) => !c.review_key.startsWith('bau-test-'));
  const proc = path.join(sb.shared, 'csv processed');
  const googleFile = path.join(sb.shared, 'csv', 'raw-03b-google-reviews.csv');
  const googleRows = fs.existsSync(googleFile) ? readCsvObjects(googleFile).rows : [];
  return applyChoices({ choices, googleRows, overridesFile: path.join(proc, '15-review-attribution-overrides.csv'), aliasFile: path.join(proc, '16-review-reviewer-aliases.csv') });
}

/** Live products Alan can pick from (raw-01, visible), for the "Choose another product" list. */
function productsForChoice(sb) {
  const rows = readCsvObjects(path.join(sb.shared, 'csv', 'raw-01-products-sqsp-export.csv')).rows.filter((r) => r.Title && r['Product URL'] && r.Visible !== 'No');
  return [...new Map(rows.map((r) => [r['Product URL'], { slug: r['Product URL'], name: r.Title.trim() }])).values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** One actionable Needs Alan card per held review (+ simulated ones in a dry test run). */
function heldReviewCards(ctx, sb) {
  const pendingFile = path.join(sb.shared, 'csv processed', '03b-google-pending-alan-review.csv');
  const pending = fs.existsSync(pendingFile) ? readCsvObjects(pendingFile).rows : [];
  const report = readJson(path.join(sb.shared, 'outputs', 'reports', 'shadow-review-matcher-LATEST.json'), { results: [] });
  const products = productsForChoice(sb);
  const sim = ctx.mode === 'dry' ? simulatedHeld(Number(ctx.simulateHeld || 0), products) : [];
  return { items: [...heldItems(pending, report.results || []), ...sim], real: pending.length, products };
}

/** Shadow matcher (report only): before/after adding Squarespace orders, from its report in the sandbox. */
function shadowSummary(sb) {
  const file = path.join(sb.shared, 'outputs', 'reports', 'shadow-review-matcher-LATEST.json');
  if (!fs.existsSync(file)) return null;
  const s = JSON.parse(fs.readFileSync(file, 'utf8')).summary || {};
  const bt = (k) => s.backtest?.[k] || {};
  const fmt = (t) => `${t.agree || 0} agree / ${t.held || 0} held / ${t.disagree || 0} disagree`;
  return { summary: s, line: `Review matcher (shadow, report only): back-test on ${s.backtest?.decisions || 0} of Alan's decisions — before orders ${fmt(bt('before'))}; with orders ${fmt(bt('after'))}.` };
}

// ---------- 5. product schema ----------
async function productSchema(ctx) {
  ensureDry(ctx);
  const sb = buildSandbox(ctx);
  const clean = await sh('python', ['clean-products-csv.py'], { cwd: sb.scripts, env: PY_ENV });
  if (clean.code !== 0) return { notes: [problem(`Product clean-up failed: ${tail(clean.stdout + clean.stderr)}`, 'resume the run')] };
  const out07 = path.join(sb.shared, 'csv', '07-product-schema-with-review-ratings.csv');
  const gen = await sh('python', ['generate-product-schema.py', '--write-07', out07], { cwd: sb.scripts, env: PY_ENV });
  if (gen.code !== 0) return { notes: [problem(`Product schema generator failed: ${tail(gen.stdout + gen.stderr)}`, 'resume the run')] };
  const dates = await sh('python', ['check-review-dates.py'], { cwd: sb.scripts, env: PY_ENV });
  const homes = await sh('python', ['check-product-review-homes.py'], { cwd: sb.scripts, env: PY_ENV });
  const num = (re) => Number((gen.stdout.match(re) || [])[1] || 0);
  const d07 = productDiff07(sb, out07);
  const counts = { faq_files: num(/Product FAQ files generated: (\d+)/), faq_unknown: num(/FAQ unknown[^:]*: (\d+)/), rows_07: lines(out07),
    review_dates: dates.code === 0 ? 'pass' : 'fail', review_homes: homes.code === 0 ? 'pass' : 'fail',
    diff_07: { changed: d07.changed, added: d07.added, removed: d07.removed, unchanged: d07.unchanged, duplicates: d07.duplicates, unexplained: d07.unexplained, fields: d07.tally } };
  if (counts.faq_unknown) record429();
  return { counts, notes: productNotes(ctx, counts, d07, [dates.code && 'review dates', homes.code && 'review homes'].filter(Boolean)),
    needsAlan: counts.faq_unknown ? [{ kind: 'faq_unknown_after_retry', count: counts.faq_unknown, file: 'outputs/schema/products/faq-fetch-status.json' }] : [],
    plain: `${verb(ctx, 'Would generate', 'Generated')} product schema for ${d07.new_rows} products and the chat product file (07): ${d07.changed} products changed since the live 07, every change explained.`,
    details: d07.products.map((p) => `${p.product}: ${p.change === 'changed' ? p.changes.map((c) => `${c.what} ${c.live} → ${c.new} (${c.why || 'UNEXPLAINED'})`).join('; ') : p.change}`),
    outputs: [`${sb.shared}/outputs/schema/products (sandbox)`, `${out07} (sandbox)`, path.join(sb.root, '07-diff.json')] };
}

/** P11: the new 07 against the live 07, per product, each change tied to its source (Squarespace now / the published 04). */
function productDiff07(sb, out07) {
  const pick = (rel) => [path.join(sb.shared, rel), `${SHARED}/${rel}`].find((p) => fs.existsSync(p));
  const rows04 = readCsvObjects(pick('csv processed/04 – alanranger_product_schema_FINAL_WITH_REVIEW_RATINGS.csv')).rows;
  const d = diff07(readCsvObjects(`${SHARED}/csv/07-product-schema-with-review-ratings.csv`).rows, readCsvObjects(out07).rows,
    readCsvObjects(pick('csv/raw-01-products-sqsp-export.csv')).rows, rows04);
  fs.writeFileSync(path.join(sb.root, '07-diff.json'), JSON.stringify(d, null, 2));
  return d;
}

function productNotes(ctx, counts, d07, failedGuards) {
  const notes = failedGuards.map((g) => problem(`The ${g} guard failed`, 'tell Claude; nothing is published'));
  if (d07.duplicates) notes.push(problem(`${d07.duplicates} duplicate products in the new 07`, 'tell Claude'));
  if (d07.unexplained) notes.push(check(`${d07.unexplained} product schema changes have no matching source`, 'look at the UNEXPLAINED lines in Details'));
  if (counts.faq_unknown) notes.push(check(`${counts.faq_unknown} product FAQs could not be read after one paced retry, so the live FAQ was kept`, 'check those product pages load'));
  if (d07.changed) notes.push(info(`${plural(d07.changed, 'product')} ${verb(ctx, 'would get', 'got')} updated schema (prices, dates, titles and review totals now on Squarespace and in the reviews).`));
  return notes;
}

// ---------- 6 / 7 / 9. Schema Tools app generators via scripts/app-cli.mjs (same functions, output into the sandbox) ----------
function appCliArgs(command, sb, out) {
  const args = ['scripts/app-cli.mjs', command, '--out', out, '--csv', path.join(sb.shared, 'csv')];
  const processed = path.join(sb.shared, 'csv processed');
  const mappings = path.join(processed, '05-event-product-mappings-latest.csv');
  if (command === 'event-index') return [...args, '--mappings', mappings, '--processed', processed];
  return command === 'event-posts' ? [...args, '--mappings', mappings] : args;
}

/** Files a generator step changed against alanranger-schema (the publish set for its stage). */
export const changedFiles = (diff) => [...new Set([...diff.differing.map((d) => String(d.file || d).split(' — ')[0]), ...diff.new_files])];

/** Event Index: per file, events listed, past-dated events dropped and whether the hosted file would change. */
function eventIndexReport(ctx, out, report, diff) {
  const runs = JSON.parse(report.log || '[]');
  const changed = new Set(changedFiles(diff));
  const counts = Object.fromEntries(runs.map((r) => [r.file, `${r.events_listed} events listed, ${r.past_dated_dropped} past-dated dropped${r.other_not_listed ? `, ${r.other_not_listed} other not listed` : ''}, ${changed.has(r.file) ? 'changed' : 'unchanged'}`]));
  const listed = runs.reduce((n, r) => n + (r.events_listed || 0), 0);
  const notes = runs.length === 2 ? [] : [problem('The Event Index did not produce both list files', 'resume the run; tell Claude if it fails again')];
  if (changed.size) notes.push(info(`${plural(changed.size, 'event list file')} changed (events added or past events dropped); ${verb(ctx, 'they would be published in this stage', 'published in this stage')}.`));
  return { counts: { ...counts, would_change: changed.size, seconds: report.seconds }, notes,
    plain: `${verb(ctx, 'Would rebuild', 'Rebuilt')} the lessons and workshops event lists: ${listed} upcoming events listed.`,
    details: Object.entries(counts).map(([f, v]) => `${f}: ${v}`), outputs: [`${out} (sandbox)`, path.join(out, 'compare.json')] };
}

/** P5: landings were report-only in LIVE until the difference list was approved (Claude, batch 5: switched on). */
export const LANDINGS_REPORT_ONLY = false;

/** Landings: every difference against the hosted files, tied to its live source (scripts/landing-diff-explain.mjs). */
async function landingsReport(ctx, out, report, diff, reportOnly) {
  const file = path.join(out, 'landing-diff-explain.json');
  const r = await sh('node', ['scripts/landing-diff-explain.mjs', out, '--json', file], { cwd: SCHEMA_TOOLS });
  if (r.code !== 0) return { notes: [problem(`Landing difference check failed: ${tail(r.stderr || r.stdout)}`, 'resume the run')] };
  const ex = JSON.parse(fs.readFileSync(file, 'utf8'));
  const lines = ex.rows.filter((row) => row.notes.length).map((row) => `${row.file}: ${row.notes.join(' | ')}`);
  const rated = ex.businessRatingFiles || [];
  if (rated.length) return { notes: [problem(`A business rating is on landing files (P23): ${rated.join(', ')}`, 'tell Claude; nothing is published')], outputs: [file] };
  const notes = ex.unexplained.length ? [check(`${ex.unexplained.length} landing page differences have no live source`, 'look at the Details; tell Claude')] : [];
  if (lines.length) notes.push(info(`${lines.length} of ${ex.files} landing pages changed, each explained by what is live on the site now; ${verb(ctx, 'they would be published in this stage', 'published in this stage')}.`));
  return { notes,
    counts: { live_mode: reportOnly ? 'report-only (P5)' : 'live', compared: ex.files, landing_files: ex.landingFilesGenerated, would_change: changedFiles(diff).length,
      business_rating_nodes: 0, unexplained: ex.unexplained.length, files_written: report.files_written, seconds: report.seconds },
    plain: `${verb(ctx, 'Would rebuild', 'Rebuilt')} schema for ${ex.landingFilesGenerated} landing and service pages from what is live on the site; no business rating anywhere.`,
    details: lines, outputs: [`${out} (sandbox)`, file, path.join(out, 'compare.json')] };
}

const APP_LABEL = { 'event-posts': ['event pages and hub FAQs', 'event'], 'blog-index': ['the blog index', 'blog index'] };

async function runAppCli(command, sb) {
  const out = path.join(sb.root, 'app-cli', command);
  const run = await sh('node', appCliArgs(command, sb, out), { cwd: SCHEMA_TOOLS, env: { ALAN_SITE_GAP_SECONDS: '2' }, timeoutMs: 30 * 60 * 1000 });
  if (run.code !== 0) return { out, error: `${command} generator failed: ${tail(run.stderr || run.stdout)}` };
  const cmp = await sh('node', ['scripts/app-cli-compare.mjs', out, '--ignore-run-dates'], { cwd: SCHEMA_TOOLS });
  const diff = JSON.parse(cmp.stdout.slice(cmp.stdout.indexOf('{')));
  fs.writeFileSync(path.join(out, 'compare.json'), JSON.stringify(diff, null, 2));
  return { out, diff, report: JSON.parse(fs.readFileSync(path.join(out, 'app-cli-report.json'), 'utf8')) };
}

const appCliStep = (command) => async (ctx) => {
  ensureDry(ctx);
  const sb = buildSandbox(ctx);
  const { out, diff, report, error } = await runAppCli(command, sb);
  if (error) return { notes: [problem(error, 'resume the run')] };
  const reportOnly = command === 'landings' && LANDINGS_REPORT_ONLY;
  if (command === 'landings') return landingsReport(ctx, out, report, diff, reportOnly);
  if (command === 'event-index') return eventIndexReport(ctx, out, report, diff);
  const changed = changedFiles(diff);
  const [what, kind] = APP_LABEL[command];
  return { counts: { files_written: report.files_written, compared: diff.compared, byte_identical: diff.identical, identical_except_run_dates: diff.identical_except_run_dates || 0, would_change: changed.length, seconds: report.seconds },
    notes: changed.length ? [info(`${plural(changed.length, `${kind} file`)} changed since the last publish (events or posts changed on the site); ${verb(ctx, 'they would be published in this stage', 'published in this stage')}.`)] : [],
    plain: `${verb(ctx, 'Would generate', 'Generated')} ${what} with the Schema Tools app's own generator: ${plural(report.files_written, 'file')}, ${changed.length} changed.`,
    details: changed.map((f) => `changed: ${f}`), outputs: [`${out} (sandbox)`, path.join(out, 'compare.json')] };
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
  const regen = list.length ? await regenerateBlogPosts(sb, listFile) : { error: null, posts: [], changed: [] };
  if (regen.error) return { notes: [problem(regen.error, 'resume the run')] };
  const gone = deletedPostsPlan(sb, feed);
  fs.writeFileSync(path.join(sb.root, 'blog-deleted-posts.json'), JSON.stringify(gone));
  const slugs = list.map((u) => u.split('/').pop());
  const notes = list.length ? [info(`${plural(list.length, 'blog post')} changed on the site since last month; ${verb(ctx, 'they would be updated', 'they were updated')} (all 6 schema file types each).`)] : [];
  const dates = publishDateMismatches(regen.out, feed, slugs);
  if (dates.length) notes.push(check(`datePublished differs from the Squarespace publish date on ${dates.join('; ')}`, 'tell Claude: the generator must use the post\'s Squarespace publish date'));
  notes.push(...gone.plan.remove.map((s) => info(`Deleted post ${s}: its schema files ${verb(ctx, 'would be removed', 'were removed')} (no longer in the sitemap or feed).`)));
  return { counts: { posts: feed.length, new: r.fresh.length, changed: r.changed.length, updated_on_only_held_by_gate: r.touchedOnly.length,
    would_regenerate: list.length, regenerate_scope: 'all 6 file types (_schema, _blogposting, _breadcrumb, _image, _faq / _howto when the page has them)',
    files_per_post: Object.fromEntries(regen.posts.map((p) => [p.slug, `${p.files.length} files${p.removed_stale.length ? `, stale removed: ${p.removed_stale.join(' ')}` : ''}`])),
    files_changed: regen.changed.length, deleted_posts: gone.slugs.length, baseline: firstRun ? 'last 01 export (no blogs-manifest.json yet)' : 'blogs-manifest.json' },
    notes, plain: list.length ? `${verb(ctx, 'Would update', 'Updated')} ${plural(list.length, 'changed blog post')} (all 6 file types each) with the Blog Posts tab's own generator: ${slugs.join(', ')}.` : 'No blog posts changed since last month.',
    details: [`${r.touchedOnly.length} posts only had their "updated" date bumped (held by the body check)`, `baseline: ${firstRun ? 'last 01 export (blogs-manifest.json is written by the first live run)' : 'blogs-manifest.json'}`,
      ...regen.posts.map((p) => `${p.slug}: ${p.files.join(', ')}`)],
    needsAlan: gone.plan.needsAlan.length ? [{ kind: 'deleted_blog_posts_over_limit', count: gone.plan.needsAlan.length, file: gone.plan.needsAlan.join('; ') }] : [],
    outputs: [`${manifestFile} (sandbox)`, listFile, regen.out].filter(Boolean) };
}

/** Claude 3 Nov (6.3): datePublished / dateCreated = the post's Squarespace publish day (feed publishOn), on every regenerated post. */
export function publishDateMismatches(outDir, feed, slugs) {
  const bad = [];
  for (const slug of slugs) {
    const item = feed.find((i) => i.urlId === slug);
    const file = outDir && path.join(outDir, 'alanranger-schema', `${slug}_blogposting.json`);
    if (!item?.publishOn || !file || !fs.existsSync(file)) continue;
    const want = new Date(Number(item.publishOn)).toISOString().slice(0, 10);
    const bp = JSON.parse(fs.readFileSync(file, 'utf8'));
    const got = [bp.datePublished, bp.dateCreated].map((d) => String(d || '').slice(0, 10));
    if (got.some((d) => d !== want)) bad.push(`${slug} (${got.join(' / ')} vs Squarespace ${want})`);
  }
  return bad;
}

/** Changed posts through app-cli blog-posts (the Blog Posts tab's own single-URL generator) into the sandbox. */
async function regenerateBlogPosts(sb, listFile) {
  const out = path.join(sb.root, 'app-cli', 'blog-posts');
  const run = await sh('node', ['scripts/app-cli.mjs', 'blog-posts', '--out', out, '--list', listFile], { cwd: SCHEMA_TOOLS, env: { ALAN_SITE_GAP_SECONDS: '2' }, timeoutMs: 30 * 60 * 1000 });
  if (run.code !== 0) return { error: `Blog posts generator failed: ${tail(run.stderr || run.stdout)}` };
  const report = JSON.parse(fs.readFileSync(path.join(out, 'app-cli-report.json'), 'utf8'));
  const cmp = await sh('node', ['scripts/app-cli-compare.mjs', out, '--ignore-run-dates'], { cwd: SCHEMA_TOOLS });
  const diff = JSON.parse(cmp.stdout.slice(cmp.stdout.indexOf('{')));
  fs.writeFileSync(path.join(out, 'compare.json'), JSON.stringify(diff, null, 2));
  return { error: null, out, posts: JSON.parse(report.log || '[]'), changed: changedFiles(diff) };
}

/** Posts with files in the schema repo that are in neither the blog feed nor the sitemap (live: max 5 removed per run). */
function deletedPostsPlan(sb, feed) {
  const repoFiles = fs.readdirSync(`${SCHEMA_TOOLS}/alanranger-schema`);
  const sitemap = fs.readFileSync(path.join(sb.root, 'feeds', 'sitemap.xml'), 'utf8');
  const sitemapSlugs = [...sitemap.matchAll(/\/blog-on-photography\/([^<\s/]+)<\/loc>/g)].map((m) => m[1]);
  const slugs = deletedBlogPosts(repoFiles, feed.map((i) => i.urlId), sitemapSlugs);
  return { slugs, plan: planDeletedPostCleanup(slugs) };
}

// ---------- publish (per stage: only that stage's files; dry = what would be published, live = promote the dry run) ----------
export const REPO = `${SCHEMA_TOOLS}/alanranger-schema`;
/** The schema repo for this run (the proof points it at a throwaway clone; real runs use REPO). */
const repoOf = (ctx) => ctx.schemaRepo || REPO;
const readJson = (file, fallback) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback);
const compareOf = (sb, command) => changedFiles(readJson(path.join(sb.root, 'app-cli', command, 'compare.json'), { differing: [], new_files: [] }));

/** D: product *_schema.json / *_faq.json named in the new 04 that differ from the schema repo. */
export function productPublishSet(sb, repo = REPO) {
  const src = path.join(sb.shared, 'outputs', 'schema', 'products');
  const final04 = fs.readFileSync(path.join(sb.shared, 'csv processed', '04 – alanranger_product_schema_FINAL_WITH_REVIEW_RATINGS.csv'), 'utf8');
  const set = [...new Set([...final04.matchAll(/[\w-]+_schema\.json/g)].map((m) => m[0]))]
    .flatMap((f) => [f, f.replace('_schema.json', '_faq.json')]).filter((f) => fs.existsSync(path.join(src, f)));
  return { publish: set.filter((f) => !fs.existsSync(path.join(repo, f)) || fs.readFileSync(path.join(src, f), 'utf8') !== fs.readFileSync(path.join(repo, f), 'utf8')), remove: [] };
}
const BLOG_SUFFIXES = ['_schema.json', '_blogposting.json', '_breadcrumb.json', '_image.json', '_faq.json', '_howto.json'];
/** F: blog index + changed post files, and the files of deleted posts (removed). */
export function blogPublishSet(sb, repo = REPO) {
  const gone = readJson(path.join(sb.root, 'blog-deleted-posts.json'), { plan: { remove: [] } });
  const remove = gone.plan.remove.flatMap((slug) => BLOG_SUFFIXES.map((s) => `${slug}${s}`)).filter((f) => fs.existsSync(path.join(repo, f)));
  return { publish: [...compareOf(sb, 'blog-index'), ...compareOf(sb, 'blog-posts')], remove };
}
const appOut = (sb, command) => path.join(sb.root, 'app-cli', command, 'alanranger-schema');
/** Publish sets per stage: each lists only its own generators' files; `sources` = where those files sit in the sandbox. */
export const PUBLISH = {
  publish_products: { stage: 'D', set: productPublishSet, sources: (sb) => [path.join(sb.shared, 'outputs', 'schema', 'products')], sample: 'products-manifest.json', what: 'product' },
  publish_events: { stage: 'E', set: (sb) => ({ publish: [...compareOf(sb, 'event-posts'), ...compareOf(sb, 'event-index')], remove: [] }),
    sources: (sb) => [appOut(sb, 'event-posts'), appOut(sb, 'event-index')], sample: 'events-manifest.json', what: 'event' },
  publish_blogs: { stage: 'F', set: blogPublishSet, sources: (sb) => [appOut(sb, 'blog-index'), appOut(sb, 'blog-posts')], sample: 'blog-schema.json', what: 'blog',
    after: blogManifestAfterPublish },
  publish_landings: { stage: 'G', set: (sb) => ({ publish: compareOf(sb, 'landings'), remove: [] }), sources: (sb) => [appOut(sb, 'landings')], sample: 'landings-manifest.json', what: 'landing page' }
};

/** F live: the dry run's blogs-manifest.json becomes the baseline for next month (previous copy kept for undo; auto-sync commits it). */
function blogManifestAfterPublish(sb, ctx) {
  const next = path.join(sb.shared, 'outputs', 'schema', 'blogs-manifest.json');
  const live = path.join(ctx.sharedRoot || SHARED, 'outputs', 'schema', 'blogs-manifest.json');
  if (!fs.existsSync(next)) return { manifest: 'none in the dry run' };
  const prev = fs.existsSync(live) ? live.replace(/\.json$/, `.prev-${String(ctx.runId).slice(0, 8)}.json`) : null;
  if (prev) fs.copyFileSync(live, prev);
  fs.mkdirSync(path.dirname(live), { recursive: true });
  fs.copyFileSync(next, live);
  return { manifest: live, manifest_previous: prev || 'none (first live run)' };
}

const publishStep = (id) => async (ctx) => {
  const def = PUBLISH[id];
  const sb = buildSandbox(ctx);
  const repo = repoOf(ctx);
  const set = def.set(sb, repo);
  const removals = await publishRemovals(def, sb, ctx, set.publish, repo);
  if (ctx.mode === 'live') return livePublish(def, sb, ctx, { ...set, removals, repo });
  const { publish, remove } = set;
  const cdn = await fetch(`https://schema.alanranger.com/${def.sample}?t=${Date.now()}`).then((r) => r.status).catch(() => 0);
  const notes = cdn === 200 ? [] : [check(`The schema CDN sample (${def.sample}) returned ${cdn}`, 'open schema.alanranger.com; resume the run when it answers')];
  const total = publish.length + remove.length;
  if (total) notes.push(info(`${verb(ctx, 'Would publish', 'Published')} ${plural(publish.length, `${def.what} file`)}${remove.length ? ` and ${verb(ctx, 'would remove', 'removed')} ${remove.length}` : ''} in the schema repo (this stage's files only).`));
  notes.push(...removalNotes(def, removals));
  return { counts: { files: publish, removed: remove, publish_count: publish.length, remove_count: remove.length, cdn_sample: `${def.sample} ${cdn}`, commit: null, ...removalCounts(removals) },
    notes, plain: total ? `${verb(ctx, 'Would publish', 'Published')} ${plural(total, 'file')} for stage ${def.stage}, then check the CDN and a sample page.` : `Nothing to publish for stage ${def.stage}.`,
    details: [...publish.map((f) => `${verb(ctx, 'would publish', 'published')}: ${f}`), ...remove.map((f) => `${verb(ctx, 'would remove', 'removed')}: ${f}`), `CDN sample ${def.sample}: ${cdn}`, ...removalDetails(removals)] };
};

// ---------- 12. export 09 (dry: DB count only) ----------
async function export09(ctx) {
  ensureDry(ctx);
  const rows = await query(ctx, 'traditional_seo_target_keyword_overrides?select=id');
  const fileRows = lines(`${SHARED}/csv/09-url-target-keywords.csv`);
  return { counts: { db_override_rows: rows?.length ?? 'n/a', csv_09_rows: fileRows },
    plain: `${verb(ctx, 'Would export', 'Exported')} the target keywords (09): ${rows?.length ?? '?'} keyword rows in the database, ${fileRows} in the saved file.`,
    details: [verb(ctx, 'dry run: database row count only; nothing written', 'csv/09-url-target-keywords.csv written from the database')] };
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

export const AUDIT_NOT_SELECTED = 'skipped — not selected';

async function audit(ctx) {
  if (ctx.includeAudit === false) {
    return { status: 'skipped', counts: { include_audit: false, info: ['① full audit not selected for this run (Monday ① runs as usual)'] },
      notes: [info(`① full audit ${AUDIT_NOT_SELECTED} for this run (the Monday ① runs as usual).`)], plain: 'Full audit ① not selected for this run.', details: [AUDIT_NOT_SELECTED] };
  }
  const monday = new Date().getUTCDay() === 1;
  const running = await query(ctx, 'fault_monitor_runs?select=id,status&status=in.(running,started)&limit=1');
  const counts = { monday_utc: monday, audit_already_running: running?.length || 0 };
  if (ctx.mode === 'dry') {
    return { status: 'skipped', counts, notes: [info('① is simulated in a dry run (no requests sent).')], plain: 'Would start the full audit ① (simulated in a dry run).',
      details: [`Live: POST ${RENDER_API} {action:'start', source:'trad_seo'}, then wait on fault_monitor_runs (render, then broken links; the */5 cron advances it)`] };
  }
  if (monday) return { counts, notes: [problem('Never on a Monday: the Monday cron runs ①', 'run ① on another day')] };
  if (counts.audit_already_running) return { counts, notes: [check('① is already running, so it was not started again', 'nothing to do; it finishes on its own')] };
  return liveAudit();
}

/** Product *_schema.json names (+ _faq.json) from 04, and blog url ids from 01 (sandbox copies when the run made them). */
function producerInputs(ctx) {
  const sb = sandboxFor(ctx);
  const pick = (rel) => [path.join(sb.shared, rel), `${SHARED}/${rel}`].find((p) => fs.existsSync(p));
  const final04 = fs.readFileSync(pick('csv processed/04 – alanranger_product_schema_FINAL_WITH_REVIEW_RATINGS.csv'), 'utf8');
  const schemas = [...new Set([...final04.matchAll(/[\w-]+_schema\.json/g)].map((m) => m[0]))];
  const productFiles = new Set(schemas.flatMap((f) => [f, f.replace('_schema.json', '_faq.json')]));
  const blogSlugs = new Set(readCsvObjects(pick('csv/01-blog-posts.csv')).rows.map((r) => r['Url Id']).filter(Boolean));
  return { productFiles, blogSlugs };
}

function coverageCheck(ctx) {
  const { productFiles, blogSlugs } = producerInputs(ctx);
  const c = coverage(`${SCHEMA_TOOLS}/alanranger-schema`, productFiles, blogSlugs);
  const warnings = [...c.orphans.map((f) => `no producer for ${f}`), ...c.uncoveredTabs.map((t) => `generator tab ${t} produces no file in the repo`)];
  return { c, line: coverageLine(c), warnings };
}

/** Notes per level across the steps (the page shows the same three counts). */
export function levelCounts(notesLists) {
  const all = notesLists.flat();
  return { info: all.filter((n) => n.level === 'info').length, check: all.filter((n) => n.level === 'check').length, problem: all.filter((n) => n.level === 'problem').length };
}

/** Step tally + the three note levels (this summary's own notes included) + the schema repo coverage check. */
async function summary(ctx) {
  const others = ctx.steps.filter((s) => s.step_id !== 'summary');
  const tally = [...others, { status: 'ok' }].reduce((m, s) => ({ ...m, [s.status]: (m[s.status] || 0) + 1 }), {});
  const cov = coverageCheck(ctx);
  const own = [...cov.warnings.map((w) => check(w, 'tell Claude: a schema file has no producer')), info(cov.line)];
  const levels = levelCounts([...others.map((s) => s.notes || []), own]);
  const covered = { line: cov.line, files: cov.c.total, orphans: cov.c.orphans, by_step: cov.c.byStep, tabs: TABS };
  const infoLines = others.flatMap((s) => s.counts?.info || []);
  await ctx.store?.updateRun?.(ctx.runId, { summary: { tally, levels, info: infoLines, coverage: covered, steps: ctx.steps.map((s) => ({ id: s.step_id, status: s.status, counts: s.counts })) } });
  const needs = levels.problem ? `${plural(levels.problem, 'problem')} to fix` : levels.check ? `${plural(levels.check, 'thing')} to look at` : 'nothing needs you';
  return { counts: { ...tally, levels, coverage: cov.line, coverage_by_step: cov.c.byStep, info: infoLines }, notes: own,
    plain: `${verb(ctx, 'Dry run', 'Live run')} finished: ${needs}. ${cov.line}.`, details: Object.entries(tally).map(([k, v]) => `${k}: ${v} steps`) };
}

/** Generators never run in Live: the stage publishes the files its dry run already generated and reported. */
const promoted = (handler) => async (ctx) => (ctx.mode !== 'live' ? handler(ctx) : {
  status: 'skipped', notes: [info(`Not regenerated in Live: this stage publishes dry run ${String(ctx.promote?.run_id || '?').slice(0, 8)}'s files.`)],
  plain: `Promoted from dry run ${String(ctx.promote?.run_id || '?').slice(0, 8)} (not regenerated).`, counts: { promoted_from: ctx.promote?.run_id || null } });

export const HANDLERS = {
  preflight, build_csvs: buildCsvs, ingest_preliminary: ingestPreliminary, reviews, product_schema: promoted(productSchema), publish_products: publishStep('publish_products'),
  event_posts: promoted(appCliStep('event-posts')), event_index: promoted(appCliStep('event-index')), publish_events: publishStep('publish_events'),
  blog_index: promoted(appCliStep('blog-index')), blog_posts: promoted(blogPosts), publish_blogs: publishStep('publish_blogs'),
  landing_pages: promoted(appCliStep('landings')), publish_landings: publishStep('publish_landings'),
  final_ingest: finalIngest, export_09: export09,
  audit,
  summary
};

/** File or folder copy that overwrites (fs.cpSync fails on Windows when replacing some existing files). */
function copyInto(from, to) {
  if (fs.statSync(from).isDirectory()) return copyDir(from, to);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  return null;
}

/** Before a stage run: copy the prerequisite stages' saved outputs (their runs' sandboxes) into this run's sandbox. */
export function seedSandbox(ctx, sources) {
  const sb = buildSandbox(ctx);
  const seeded = [];
  for (const src of sources) {
    for (const rel of src.seeds) {
      const from = path.join(src.sandbox || '', rel);
      if (!src.sandbox || !fs.existsSync(from)) return { missing: `stage ${src.stage} (run ${String(src.run_id).slice(0, 8)}): ${rel}` };
      copyInto(from, path.join(sb.root, rel));
      seeded.push(`${src.stage}: ${rel}`);
    }
  }
  return { seeded, root: sb.root };
}
