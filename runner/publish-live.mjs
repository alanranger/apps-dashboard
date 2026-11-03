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

const SCHEMA_TOOLS = 'G:/Dropbox/alan ranger photography/Website Code/Schema Tools';
const { commitAndPush, assertClean } = await import(pathToFileURL(`${SCHEMA_TOOLS}/scripts/lib/deploy-schemas.mjs`).href);
const { readCsvObjects } = await import(pathToFileURL(`${SCHEMA_TOOLS}/scripts/csv-builders/lib.mjs`).href);

/** Stages whose live path is built and proven (the runner refuses Live for the rest). */
export const LIVE_STAGES = new Set(['F']);

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

const norm = (s) => s.replace(/\r\n/g, '\n');
/** Files that still differ from the repo now (line endings ignored): a file published since the dry run drops out. */
function stillDiffering(files, repo, src) {
  return files.filter((f) => !fs.existsSync(path.join(repo, f)) || norm(fs.readFileSync(path.join(repo, f), 'utf8')) !== norm(fs.readFileSync(src(f), 'utf8')));
}

/** Why this live publish must not go ahead, or null. */
function liveRefusal(def, ctx, set, current) {
  if (!LIVE_STAGES.has(def.stage)) return [`Live publishing for stage ${def.stage} is not built yet`, 'run it dry'];
  if (!ctx.promote) return ['No dry run to promote', `run stage ${def.stage} dry first`];
  if (!sameSet(current, ctx.promote.published || []) || !sameSet(set.remove, ctx.promote.removed || [])) {
    return [`The schema repo changed since dry run ${String(ctx.promote.run_id).slice(0, 8)}: the publish list is different now`, `run stage ${def.stage} dry again, then Live`];
  }
  if (set.removals.unexplained.length) return [`${plural(set.removals.unexplained.length, 'unexplained removal')} in the publish set`, 'fix or explain them, then dry-run again'];
  return null;
}

/** After the push: GitHub Pages serves the new bytes (polled; a slow CDN is a check, not a failure). */
async function cdnCheck(file, repo, ctx) {
  if (ctx.cdnCheck === false) return 'skipped (proof run)';
  const want = fs.readFileSync(path.join(repo, file), 'utf8');
  for (let i = 0; i < 9; i += 1) {
    const body = await fetch(`https://schema.alanranger.com/${file}?t=${Date.now()}`).then((r) => (r.ok ? r.text() : '')).catch(() => '');
    if (body === want) return 'serving the published bytes';
    await new Promise((r) => setTimeout(r, 20000));
  }
  return 'not updated after 3 minutes';
}

/** LIVE: copy the dry run's files into the schema repo, commit exactly them, push, check the CDN. */
export async function livePublish(def, sb, ctx, set) {
  const src = (f) => def.sources(sb).map((d) => path.join(d, f)).find((p) => fs.existsSync(p));
  const current = LIVE_STAGES.has(def.stage) && ctx.promote ? stillDiffering(set.publish, set.repo, src) : set.publish;
  const refused = liveRefusal(def, ctx, set, current);
  if (refused) return { notes: [note('problem', refused[0], refused[1])], counts: { ...removalCounts(set.removals), commit: null } };
  const { repo, publish, remove } = set;
  assertClean(repo);
  for (const f of publish) fs.copyFileSync(src(f), path.join(repo, f));
  for (const f of remove) fs.rmSync(path.join(repo, f), { force: true });
  const message = `BAU ${def.stage} live from dry run ${String(ctx.promote.run_id).slice(0, 8)}: ${plural(publish.length, `${def.what} file`)}${remove.length ? `, ${remove.length} removed` : ''}`;
  const r = commitAndPush({ repo, files: [...publish, ...remove], message, expectExact: true, restoreOnAbort: true });
  const cdn = publish.length ? await cdnCheck(publish[0], repo, ctx) : 'nothing published';
  const after = def.after && r.commit ? def.after(sb, ctx, r) : {};
  const notes = [note('info', `Published ${plural(publish.length, `${def.what} file`)}${remove.length ? ` and removed ${remove.length}` : ''} in commit ${String(r.commit).slice(0, 8)} (dry run ${String(ctx.promote.run_id).slice(0, 8)}'s files).`)];
  if (!/serving|skipped|nothing/.test(cdn)) notes.push(note('check', `schema.alanranger.com is ${cdn}`, 'open the file on schema.alanranger.com in a few minutes'));
  return { counts: { files: publish, removed: remove, publish_count: publish.length, remove_count: remove.length, commit: r.commit, promoted_from: ctx.promote.run_id,
    cdn_sample: `${publish[0] || '-'}: ${cdn}`, ...removalCounts(set.removals), ...after },
    notes, plain: `Published ${plural(publish.length + remove.length, 'file')} for stage ${def.stage} (commit ${String(r.commit).slice(0, 8)}), from dry run ${String(ctx.promote.run_id).slice(0, 8)}.`,
    details: [...publish.map((f) => `published: ${f}`), ...remove.map((f) => `removed: ${f}`), `commit: ${r.commit}`, `CDN: ${cdn}`] };
}
