/**
 * BAU Monthly stages (A–I). Shared by the page API (Vercel, CommonJS) and the PC runner (ESM via createRequire).
 * A stage run = pre-flight + the stage's steps + summary. Run all = every stage in order (stages = null).
 * Prerequisites are checked, not forced: planStage() says what must run first and offers the chain.
 */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DONE = new Set(['ok', 'warn']);

/** seeds: what a later stage reads from this stage's saved output (dry: paths inside that run's sandbox). */
const STAGES = [
  { id: 'A', name: 'Refresh data', steps: ['preflight', 'build_csvs'], needs: [],
    seeds: ['alan-shared-resources/csv', 'feeds'] },
  { id: 'B', name: 'Ingest + links', steps: ['ingest_preliminary'], needs: ['A'],
    seeds: ['alan-shared-resources/csv processed/05-event-product-mappings-latest.csv'] },
  { id: 'C', name: 'Reviews', steps: ['reviews'], needs: ['A'],
    seeds: ['alan-shared-resources/csv processed/03 – combined_product_reviews.csv', 'alan-shared-resources/csv processed/03b-google-pending-alan-review.csv',
      'alan-shared-resources/csv processed/03b_google_matched.csv', 'alan-shared-resources/csv/raw-03b-google-reviews.csv'] },
  { id: 'D', name: 'Products', steps: ['product_schema', 'publish_products'], needs: ['A', 'C'],
    seeds: ['alan-shared-resources/outputs/schema/products', 'alan-shared-resources/csv/07-product-schema-with-review-ratings.csv',
      'alan-shared-resources/csv processed/04 – alanranger_product_schema_FINAL_WITH_REVIEW_RATINGS.csv', 'alan-shared-resources/csv processed/02 – products_cleaned.xlsx'] },
  { id: 'E', name: 'Events', steps: ['event_posts', 'event_index', 'publish_events'], needs: ['A', 'B'], seeds: ['app-cli/event-posts', 'app-cli/event-index'] },
  { id: 'F', name: 'Blogs', steps: ['blog_index', 'blog_posts', 'publish_blogs'], needs: ['A'], seeds: ['app-cli/blog-index', 'app-cli/blog-posts'] },
  { id: 'G', name: 'Landing pages', steps: ['landing_pages', 'publish_landings'], needs: ['A'], seeds: ['app-cli/landings'] },
  { id: 'H', name: 'Final ingest + keywords', steps: ['final_ingest', 'export_09'], needs: ['A'], needsAny: ['D', 'E', 'F', 'G'], seeds: [] },
  { id: 'I', name: 'Full audit ①', steps: ['audit'], needs: [], seeds: [] }
];
const BY_ID = Object.fromEntries(STAGES.map((s) => [s.id, s]));
const ORDER = STAGES.map((s) => s.id);
const sortStages = (ids) => [...new Set(ids)].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));

/** Step ids for a run: null stages = every step; otherwise pre-flight + the stages' steps + summary. */
function stepsFor(stages) {
  if (!stages || !stages.length) return null;
  const ids = sortStages(stages).flatMap((s) => BY_ID[s].steps);
  return ['preflight', ...ids.filter((id) => id !== 'preflight'), 'summary'];
}

/** Latest finished result per stage for one mode, from run rows (newest first) with stage_results. */
function stageHistory(runs, mode) {
  const out = {};
  for (const run of runs) {
    for (const [id, r] of Object.entries(run.stage_results || {})) {
      if (r.mode !== mode || out[id]) continue;
      out[id] = { ...r, run_id: run.id };
    }
  }
  return out;
}

/** Why a saved stage result can't be used as an input, or null when it can. */
function staleReason(id, history, now) {
  const h = history[id];
  if (!h || !DONE.has(h.status)) return h ? `last run ${h.status}` : 'never run';
  if (now - Date.parse(h.finished_at) > MAX_AGE_MS) return 'older than 7 days';
  const before = (BY_ID[id].needs || []).find((n) => history[n] && Date.parse(history[n].finished_at) > Date.parse(h.finished_at));
  return before ? `ran before ${before} last changed its inputs` : null;
}

/** Every stage the targets depend on (not the targets themselves). */
function closure(targets) {
  const seen = new Set();
  const walk = (id) => (BY_ID[id].needs || []).forEach((n) => { if (!seen.has(n)) { seen.add(n); walk(n); } });
  targets.forEach(walk);
  targets.forEach((t) => seen.delete(t));
  return seen;
}

/** H needs any one of D–G: none usable and none in the run → D is added (products is the usual one). */
function anyOfGap(targets, history, now) {
  const need = targets.map((t) => BY_ID[t]).find((s) => s.needsAny);
  if (!need) return [];
  const usable = need.needsAny.some((id) => targets.includes(id) || !staleReason(id, history, now));
  return usable ? [] : ['D'];
}

/**
 * What must run before `targets` (same mode). Returns { ok, missing, reasons, message, chain }.
 * missing = prerequisites never run / failed / older than 7 days / run before their own inputs changed,
 * plus anything depending on a missing one.
 */
function planStage(targets, history, now = Date.now()) {
  const want = sortStages(targets);
  const extra = anyOfGap(want, history, now);
  const required = [...closure([...want, ...extra]), ...extra];
  const reasons = {};
  for (const id of required) {
    const why = extra.includes(id) && !history[id] ? 'H needs one of D, E, F or G' : staleReason(id, history, now);
    if (why) reasons[id] = why;
  }
  let missing = new Set(Object.keys(reasons));
  for (const id of sortStages(required)) if ((BY_ID[id].needs || []).some((n) => missing.has(n))) missing.add(id);
  missing = sortStages([...missing]);
  const list = (ids) => (ids.length > 1 ? `${ids.slice(0, -1).join(', ')} and ${ids[ids.length - 1]}` : ids[0]);
  const chain = sortStages([...missing, ...want]);
  return { ok: missing.length === 0, missing, reasons, chain,
    message: missing.length ? `Run ${list(missing)} first` : null,
    chainLabel: missing.length ? `Run ${chain.slice(0, -1).join(', ')}, then ${chain[chain.length - 1]}` : null };
}

/** Prerequisite stages not in this run whose saved output the run reads (for sandbox seeding). */
function seedSources(targets, history) {
  if (!targets || !targets.length) return [];
  const want = sortStages(targets);
  const anyOf = want.map((t) => BY_ID[t]).find((s) => s.needsAny)?.needsAny || [];
  const used = [...closure(want), ...anyOf.filter((id) => !want.includes(id) && history[id] && DONE.has(history[id].status))];
  return sortStages(used).filter((id) => history[id]).map((id) => ({ stage: id, run_id: history[id].run_id, sandbox: history[id].sandbox, seeds: BY_ID[id].seeds }));
}

module.exports = { STAGES, BY_ID, MAX_AGE_MS, sortStages, stepsFor, stageHistory, staleReason, planStage, seedSources };
