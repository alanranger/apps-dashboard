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

/** Stages whose live path is built and proven (the runner refuses Live for the rest). */
export const LIVE_STAGES = new Set(['F']);

const note = (level, text, todo) => (todo ? { level, text, todo } : { level, text });
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const slugOf = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** D: the product step's per-product explanation lines, keyed by the product's file slug. */
async function productNotes(ctx) {
  const lines = ctx.mode === 'live'
    ? ((await ctx.store?.query?.(`update_all_steps?select=details&run_id=eq.${ctx.promote.run_id}&step_id=eq.product_schema`))?.[0]?.details || [])
    : (ctx.steps || []).find((s) => s.step_id === 'product_schema')?.details || [];
  return new Map(lines.map((l) => [slugOf(String(l).split(': ')[0]), String(l)]));
}

/** Removals in a stage's publish set: published file (repo) → new file (sandbox). */
export async function publishRemovals(def, sb, ctx, files, repo) {
  const landing = def.stage === 'G' ? readJson(path.join(sb.root, 'app-cli', 'landings', 'landing-diff-explain.json'))?.rows || [] : [];
  const products = def.stage === 'D' ? await productNotes(ctx) : new Map();
  const src = (f) => def.sources(sb).map((d) => path.join(d, f)).find((p) => fs.existsSync(p));
  return checkPublishSet(files, {
    readBefore: (f) => readJson(path.join(repo, f)),
    readAfter: (f) => readJson(src(f)),
    contextFor: (f) => ({ stage: def.stage,
      landingNote: (landing.find((r) => `${r.file}_landing_schema.json` === f)?.notes || []).join(' | '),
      productNote: products.get(f.replace(/_(schema|faq)\.json$/, '')) || '' })
  });
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
