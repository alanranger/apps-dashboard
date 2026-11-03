/**
 * BAU Monthly Live, page side (Claude/Alan 3 Nov, step 6): the live switch state, the confirmation plan for one stage
 * (the dry run it promotes; its files and site pages, or for B/H its tables and expected row changes) and "Undo this stage".
 */
const { sb } = require('./mc/_lib');

const RUN_ALL = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'];
/** Run all live unlocks once A–H have each run live once; I (the full audit ①) is covered by its Monday schedule (Alan, 3 Nov). */
const UNLOCK_STAGES = RUN_ALL.filter((s) => s !== 'I');
const SITE = 'https://www.alanranger.com';
const MANIFEST = { D: 'products-manifest.json', E: 'events-manifest.json', G: 'landings-manifest.json' };
/** Files that belong to a hub page (or to none: manifests). */
const FIXED = { 'lessons-schema.json': '/beginners-photography-lessons', 'workshops-schema.json': '/photographic-workshops-near-me',
  'beginners-photography-lessons_faq.json': '/beginners-photography-lessons', 'photographic-workshops-near-me_faq.json': '/photographic-workshops-near-me',
  'blog-schema.json': '/blog-on-photography', 'events-manifest.json': null, 'products-manifest.json': null, 'landings-manifest.json': null };
const DB_TABLES = ['csv_metadata (full copy)', 'page_entities (full copy)', 'event_product_links_auto (full copy)', 'page_chunks (affected urls)', 'page_html (affected urls)'];

const done = (h) => h && ['ok', 'warn'].includes(h.status) && !h.undo_of;
/** B / H undo restores a database backup, kept 14 days after the live run (runner/bau-retention.mjs); file stages undo through git. */
const DB_STAGES = new Set(['B', 'H']);
const UNDO_DAYS = 14;
const undoUntil = (stage, h) => (DB_STAGES.has(stage) && h?.finished_at ? new Date(Date.parse(h.finished_at) + UNDO_DAYS * 86400000).toISOString() : null);
const undoExpired = (stage, h) => { const u = undoUntil(stage, h); return !!u && Date.parse(u) <= Date.now(); };

/** What the page may do: Live per stage when switched on (Alan only); Run all live only after every stage A–I ran live once. */
function liveState(session, history) {
  const enabled = process.env.UPDATE_ALL_LIVE_ENABLED === '1';
  const liveDone = RUN_ALL.filter((s) => done(history.live_done[s]));
  return { enabled, can_publish: enabled && session.role === 'alan', run_all_unlocked: UNLOCK_STAGES.every((s) => liveDone.includes(s)), live_done: liveDone };
}

/** file → site page, from the published manifests (schema.alanranger.com). */
async function pageMap(stage) {
  const name = MANIFEST[stage];
  if (!name) return {};
  const j = await fetch(`https://schema.alanranger.com/${name}?t=${Date.now()}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const map = {};
  for (const e of j?.entries || []) [e.schemaFileName, e.faqFileName].filter(Boolean).forEach((f) => { map[f] = e.url; });
  for (const [p, v] of Object.entries(j?.pages || {})) if (v?.file) map[v.file] = `${SITE}${p === '/home' ? '/' : p}`;
  return map;
}

function pageOf(stage, file, map) {
  if (map[file]) return map[file];
  if (file in FIXED) return FIXED[file] ? `${SITE}${FIXED[file]}` : null;
  if (stage === 'F') return `${SITE}/blog-on-photography/${file.replace(/_(schema|blogposting|breadcrumb|image|faq|howto)\.json$/, '')}`;
  return null;
}

/** B / H: the tables the run backs up and writes, and the row changes its dry ingest reported per CSV type. */
async function dbPlan(stage, runId) {
  const stepId = stage === 'B' ? 'ingest_preliminary' : 'final_ingest';
  const [step] = await sb(`update_all_steps?select=counts&run_id=eq.${encodeURIComponent(runId)}&step_id=eq.${stepId}`);
  const counts = step?.counts || {};
  const expected = Object.entries(counts).filter(([, v]) => typeof v === 'string' && /rows, \d+ new/.test(v)).map(([k, v]) => ({ csv_type: k, change: v }));
  return { backups: DB_TABLES.map((t) => `bau_bk_<run>_${t}`), expected, refetch: stage === 'B' ? (counts.refetch_plan || null) : null,
    file: stage === 'B' ? 'csv processed/05-event-product-mappings-latest.csv (re-exported after the ingest)' : 'csv/09-url-target-keywords.csv' };
}

/** The confirmation for one stage: the dry run it promotes and exactly what Live would publish. */
async function livePlan(stage, history, liveRefusal) {
  const dry = history.dry[stage] || null;
  const files = [...(dry?.published || []), ...(dry?.removed || []).map((f) => `${f} (removed)`)];
  const map = await pageMap(stage);
  const pages = [...new Set((dry?.published || []).map((f) => pageOf(stage, f, map)).filter(Boolean))];
  return { stage, audit: stage === 'I', dry: dry ? { run_id: dry.run_id, finished_at: dry.finished_at, status: dry.status } : null, refusal: liveRefusal(stage, dry),
    files, pages, db: ['B', 'H'].includes(stage) && dry ? await dbPlan(stage, dry.run_id) : null, last_live: lastLive(stage, history.live_done[stage]) };
}

/** The stage's latest live run and what "Undo this stage" would reverse (its commit + files, B/H backup, B's 05 export). */
function lastLive(stage, h) {
  if (!h) return null;
  const undo = done(h) && !undoExpired(stage, h) && (h.commit || h.backup_run || h.export_commit)
    ? { commit: h.commit || null, repo: h.repo || null, files: h.published || [], backup_run: h.backup_run || null, export_commit: h.export_commit || null } : null;
  return { run_id: h.run_id, finished_at: h.finished_at, undo_of: h.undo_of || null, promoted_from: h.promoted_from || null, undo,
    undo_until: undoUntil(stage, h), undo_expired: undoExpired(stage, h) };
}

/** "Undo this stage": a live run with options.undo_of = the stage's latest live publish (the runner re-checks it). */
async function undoRequest(session, body, history, activeRun) {
  if (process.env.UPDATE_ALL_LIVE_ENABLED !== '1' || session.role !== 'alan') return [403, { error: 'LIVE mode is not enabled yet' }];
  const stage = String(body.stage || '');
  const live = history.live_done[stage];
  if (!done(live)) return [409, { error: `There is no live publish of stage ${stage} to undo` }];
  if (undoExpired(stage, live)) return [409, { error: `Stage ${stage}'s backup expired (14-day window): it can no longer be undone` }];
  if (activeRun) return [409, { error: 'a run is already requested or running', run: activeRun }];
  const run = (await sb('update_all_runs', { method: 'POST',
    body: { mode: 'live', status: 'requested', requested_by: session.role, include_audit: false, stages: [stage], options: { undo_of: live.run_id } } }))[0];
  return [200, { run }];
}

module.exports = { RUN_ALL, liveState, livePlan, undoRequest, pageOf, undoUntil, undoExpired };
