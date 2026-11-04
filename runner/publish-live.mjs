/**
 * Publish steps, removal check + LIVE (Claude/Alan approved design, 3 Nov):
 * a live stage PROMOTES its latest dry run — the same files, byte for byte, from that run's sandbox — through
 * the one schema publish path (Schema Tools scripts/lib/deploy-schemas.mjs: exact-files commit, push), and is
 * refused when the repo changed since the dry run or a removal is unexplained.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkPublishSet } from './removals.mjs';
import { committedBlobs, servedCheck, servedText } from './served-check.mjs';

const SCHEMA_TOOLS = 'G:/Dropbox/alan ranger photography/Website Code/Schema Tools';
const { commitAndPush, pendingChanges } = await import(pathToFileURL(`${SCHEMA_TOOLS}/scripts/lib/deploy-schemas.mjs`).href);
const { readCsvObjects } = await import(pathToFileURL(`${SCHEMA_TOOLS}/scripts/csv-builders/lib.mjs`).href);

/** Stages whose live path is built and proven (the runner refuses Live for the rest). */
export const LIVE_STAGES = new Set(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
/** Database-only stages: no file list, so no removal check (their safety is the automatic backup + restore). */
export const DB_ONLY_STAGES = new Set(['B']);

const note = (level, text, todo) => (todo ? { level, text, todo } : { level, text });
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const urlKey = (u) => String(u || '').split('#')[0].replace(/\/+$/, '');

/**
 * D/E shared explanation source (Claude 3 Nov, 9.1): the published product schema (04) review_count per product.
 * A node's product = its own URL (D product files) or, for an event, the 05 mapping event_url → product_url.
 */
export function reviews04Lookup(sb) {
  const processed = path.join(sb.shared, 'csv processed');
  const p04 = path.join(processed, '04 – alanranger_product_schema_FINAL_WITH_REVIEW_RATINGS.csv');
  const p05 = path.join(processed, '05-event-product-mappings-latest.csv');
  if (!fs.existsSync(p04)) return () => null;
  // The review SET each product publishes (Review entries in its 04 schema), not the headline review_count.
  const listed = (r) => (String(r.schema_html || '').match(/"@type"\s*:\s*"Review"/g) || []).length;
  const counts = new Map(readCsvObjects(p04).rows.map((r) => [urlKey(r.url), listed(r)]));
  const products = fs.existsSync(p05) ? new Map(readCsvObjects(p05).rows.map((r) => [urlKey(r.event_url), urlKey(r.product_url)])) : new Map();
  return (nodeId) => {
    const own = urlKey(nodeId);
    return counts.get(products.get(own) || own) ?? null;
  };
}

/** Removals in a stage's publish set: published file (repo) → new file (sandbox). */
export async function publishRemovals(def, sb, ctx, files, repo) {
  const landing = def.stage === 'G' ? readJson(path.join(sb.root, 'app-cli', 'landings', 'landing-diff-explain.json'))?.rows || [] : [];
  const selling = def.stage === 'G' ? landingSellingReport(sb) : {};
  const reviews04 = ['D', 'E'].includes(def.stage) ? reviews04Lookup(sb) : null;
  const src = (f) => def.sources(sb).map((d) => path.join(d, f)).find((p) => fs.existsSync(p));
  return checkPublishSet(files, {
    readBefore: (f) => readJson(path.join(repo, f)),
    readAfter: (f) => readJson(src(f)),
    contextFor: (f) => ({ stage: def.stage, reviews04,
      landingNote: (landing.find((r) => `${r.file}_landing_schema.json` === f)?.notes || []).join(' | '),
      sellingNote: (selling[f.replace(/_landing_schema\.json$/, '')] || []).map((x) => `${x.field} = ${x.source}`).join(' | ') })
  });
}

/** Where each selling landing field came from (written by the landing generator into the run's sandbox). */
export function landingSellingReport(sb) {
  return readJson(path.join(sb.root, 'app-cli', 'landings', 'alan-shared-resources', 'outputs', 'schema', 'landings', 'landing-selling-report.json')) || {};
}

export const removalCounts = (r) => ({ removals: r.rows.length, removals_explained: r.rows.length - r.unexplained.length,
  removals_unexplained: r.unexplained.length, removals_unexplained_files: r.files_with_unexplained });

export function removalNotes(def, r) {
  if (!r.unexplained.length) return r.rows.length ? [note('info', `${plural(r.rows.length, 'removal')} in the publish set, all explained (see Details).`)] : [];
  return [note('check', `check — removals unexplained: ${plural(r.unexplained.length, 'removal')} in ${plural(r.files_with_unexplained.length, 'file')} (${r.files_with_unexplained.slice(0, 6).join(', ')}${r.files_with_unexplained.length > 6 ? ', …' : ''}). Live is blocked for stage ${def.stage} until they are explained or fixed.`,
    'look at the Details; tell Claude')];
}

export const removalDetails = (r) => r.rows.map((x) => `removed${x.explained_by ? ` (explained: ${x.explained_by})` : ' (UNEXPLAINED)'}: ${x.file} — ${x.what}${x.node !== '(file)' ? ` [${x.node}]` : ''}`);

const sameSet = (a, b) => a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');

/** Who leaves each kind of file uncommitted, for the plain refusal text. */
const LEFT_BY = [
  [/^outputs\/schema\/blogs-manifest(\.prev-[\w-]+)?\.json$/, "stage F's live publish (the blog baseline for next month)"],
  [/^csv( processed)?\/(06-site-urls\.csv|06-(prune|add)-report-latest\.json|catalog-prune-report-latest\.json)$/, 'the auto-sync (AlanSharedResourcesAutoSync) site check'],
  [/^csv\/09-url-target-keywords\.csv$/, "stage H's 09 export (or a manual edit)"]
];
export const leftBy = (file) => LEFT_BY.find(([re]) => re.test(file))?.[1] || 'something outside the BAU runner (a manual edit or another tool)';
const STATE_TEXT = { staged: 'is staged but not committed', untracked: 'is new and not committed', deleted: 'was deleted but not committed', modified: 'has changes that are not committed' };

/** Refusal when uncommitted changes block a write, or null: which file, which step left it, what to do. Nothing is written. */
export function blockedByChanges(repo, files, stage) {
  const pending = pendingChanges(repo, files);
  if (!pending.length) return null;
  const [first] = pending;
  const name = path.basename(repo);
  const more = pending.length > 1 ? ` (and ${plural(pending.length - 1, 'other file')}, see Details)` : '';
  return { notes: [note('problem', `Stage ${stage} wrote nothing: ${name}/${first.file} ${STATE_TEXT[first.state]}${more}. It was left by ${leftBy(first.file)}.`,
    `commit that file in ${name} (or undo the change if nobody meant it), then click 2. Publish live… on stage ${stage} again`)],
  counts: { commit: null, blocked_by: pending }, details: pending.map((p) => `${p.state}: ${name}/${p.file} (left by ${leftBy(p.file)})`) };
}

const norm = (s) => s.replace(/\r\n/g, '\n');
/** Files that still differ from the repo now (line endings ignored): a file published since the dry run drops out. */
function stillDiffering(files, repo, src) {
  return files.filter((f) => !fs.existsSync(path.join(repo, f)) || norm(fs.readFileSync(path.join(repo, f), 'utf8')) !== norm(fs.readFileSync(src(f), 'utf8')));
}

/** Why this live publish must not go ahead, or null. */
function liveRefusal(def, ctx, set, current) {
  if (!LIVE_STAGES.has(def.stage)) return [`Live publishing for stage ${def.stage} is not built yet`, 'use 1. Build & check'];
  if (!ctx.promote) return ['No checked build to publish', `click 1. Build & check on stage ${def.stage} first`];
  if (!sameSet(current, ctx.promote.published || []) || !sameSet(set.remove, ctx.promote.removed || [])) {
    return [`The schema repo changed since checked build ${String(ctx.promote.run_id).slice(0, 8)}: the publish list is different now`, `click 1. Build & check on stage ${def.stage} again, then 2. Publish live…`];
  }
  if (set.removals.unexplained.length) return [`${plural(set.removals.unexplained.length, 'unexplained removal')} in the publish set`, 'fix or explain them, then click 1. Build & check again'];
  return null;
}

/** One generated file into alan-shared-resources as its own commit (B's 05 export); unchanged (line endings ignored) → no commit. */
export function publishSharedFile(repo, rel, fromFile, message) {
  const live = path.join(repo, rel);
  if (fs.existsSync(live) && norm(fs.readFileSync(live, 'utf8')) === norm(fs.readFileSync(fromFile, 'utf8'))) return { file: rel, commit: null, unchanged: true };
  const blocked = blockedByChanges(repo, [rel], '?');
  if (blocked) throw new Error(`${blocked.details.join('; ')}; nothing was written`);
  fs.copyFileSync(fromFile, live);
  const r = commitAndPush({ repo, files: [rel], message, expectExact: true, restoreOnAbort: true });
  return { file: rel, commit: r.commit };
}

/** After the push: schema.alanranger.com serves every published file as committed (a slow CDN is a check, not a failure). */
async function servedFiles(publish, repo, commit, ctx, def) {
  if (def.cdn === false) return { text: 'not served by the CDN (CSV in alan-shared-resources)', differ: [] };
  if (ctx.cdnCheck === false) return { text: 'skipped (proof run)', differ: [] };
  if (!publish.length || !commit) return { text: 'nothing published', differ: [] };
  const r = await servedCheck(committedBlobs(repo, commit, publish), { onProgress: ctx.progress });
  return { ...r, text: servedText(r) };
}

/** The checked build's files already match the repo: no commit, nothing to undo (the repo's other pending work is not looked at). */
function nothingToPublish(def, ctx, set) {
  const run8 = String(ctx.promote.run_id).slice(0, 8);
  return { counts: { files: [], removed: [], publish_count: 0, remove_count: 0, commit: null, promoted_from: ctx.promote.run_id, repo_name: path.basename(set.repo), ...removalCounts(set.removals) },
    notes: [note('info', `Nothing new to publish: stage ${def.stage}'s ${def.what} files already match checked build ${run8}.`)],
    plain: `Nothing new to publish for stage ${def.stage} (checked build ${run8}'s files are already live).`, details: ['no files differ from the repo'] };
}

/** The step result when Live stops before writing: refused, nothing new, or blocked by uncommitted changes. Else null. */
function liveGate(def, ctx, set, publish) {
  const refused = liveRefusal(def, ctx, set, publish);
  if (refused) return { notes: [note('problem', refused[0], refused[1])], counts: { ...removalCounts(set.removals), commit: null } };
  if (!publish.length && !set.remove.length) return nothingToPublish(def, ctx, set);
  // Schema repo: must be clean. alan-shared-resources (A/C/H): nothing staged and the stage's own files unmodified.
  const blocked = blockedByChanges(set.repo, def.filesScope ? [...publish, ...set.remove] : null, def.stage) || def.before?.(ctx);
  return blocked ? { ...blocked, counts: { ...removalCounts(set.removals), ...blocked.counts } } : null;
}

function publishedResult(def, ctx, set, { publish, r, served, after }) {
  const { repo, remove } = set;
  const run8 = String(ctx.promote.run_id).slice(0, 8);
  const notes = [note('info', `Published ${plural(publish.length, `${def.what} file`)}${remove.length ? ` and removed ${remove.length}` : ''} in commit ${String(r.commit).slice(0, 8)} (checked build ${run8}'s files).`)];
  if (served.differ.length) notes.push(note('check', `schema.alanranger.com ${served.text}`, 'open those files on schema.alanranger.com in a few minutes; if they still differ, tell Claude'));
  return { counts: { files: publish, removed: remove, publish_count: publish.length, remove_count: remove.length, commit: r.commit, promoted_from: ctx.promote.run_id,
    repo_name: path.basename(repo), served_check: served.text, served_differ: served.differ, ...removalCounts(set.removals), ...after },
    notes, plain: `Published ${plural(publish.length + remove.length, 'file')} for stage ${def.stage} (commit ${String(r.commit).slice(0, 8)}), from checked build ${run8}.`,
    details: [...publish.map((f) => `published: ${f}`), ...remove.map((f) => `removed: ${f}`), `commit: ${r.commit}`, served.text] };
}

/** LIVE: copy the dry run's files into the schema repo, commit exactly them, push, check the CDN. */
export async function livePublish(def, sb, ctx, set) {
  const src = (f) => def.sources(sb).map((d) => path.join(d, f)).find((p) => fs.existsSync(p));
  // Publish exactly the list the refusal check approved (= the dry run's): a file that differs only in line endings is not a change.
  const publish = LIVE_STAGES.has(def.stage) && ctx.promote ? stillDiffering(set.publish, set.repo, src) : set.publish;
  const stop = liveGate(def, ctx, set, publish);
  if (stop) return stop;
  const { repo, remove } = set;
  ctx.progress?.(`Copying ${publish.length + remove.length} files into ${path.basename(repo)}`, 0, 3);
  for (const f of publish) fs.copyFileSync(src(f), path.join(repo, f));
  for (const f of remove) fs.rmSync(path.join(repo, f), { force: true });
  const message = `BAU ${def.stage} live from dry run ${String(ctx.promote.run_id).slice(0, 8)}: ${plural(publish.length, `${def.what} file`)}${remove.length ? `, ${remove.length} removed` : ''}`;
  ctx.progress?.('Committing and pushing', 1, 3);
  const r = commitAndPush({ repo, files: [...publish, ...remove], message, expectExact: true, restoreOnAbort: true });
  ctx.progress?.('Checking served files', 2, 3);
  const served = await servedFiles(publish, repo, r.commit, ctx, def);
  const after = def.after && r.commit ? def.after(sb, ctx, r) : {};
  return publishedResult(def, ctx, set, { publish, r, served, after });
}
