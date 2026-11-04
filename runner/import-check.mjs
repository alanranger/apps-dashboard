/**
 * Pre-flight import check (Alan 4 Nov): every code library the runner's generators and scripts import must be
 * installed (missing → the run stops before anything runs) and listed in that project's package.json (unlisted →
 * a later `npm install` can delete it, which is how today's E/F/G checks broke).
 * Follows local imports from each entry point; package imports are checked by node_modules lookup.
 */
import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';

const WEB = 'G:/Dropbox/alan ranger photography/Website Code';
/** Entry points the runner executes or imports, with a plain name for messages. */
export const ENTRIES = [
  ['Schema Tools/scripts/app-cli.mjs', 'the event, blog and landing page generators'],
  ['Schema Tools/scripts/app-cli-compare.mjs', 'the generator comparison'],
  ['Schema Tools/scripts/landing-diff-explain.mjs', 'the landing page change report'],
  ['Schema Tools/scripts/faq-layout-fixtures.mjs', 'the FAQ fixture gate'],
  ['Schema Tools/scripts/csv-builders/fetch-feeds.mjs', 'the CSV builders'],
  ['Schema Tools/scripts/csv-builders/fetch-event-items.mjs', 'the CSV builders'],
  ['Schema Tools/scripts/csv-builders/fetch-commerce-products.mjs', 'the CSV builders'],
  ['Schema Tools/scripts/csv-builders/build-exact.mjs', 'the CSV builders'],
  ['Schema Tools/scripts/csv-builders/build-raw01-api.mjs', 'the CSV builders'],
  ['Schema Tools/scripts/csv-builders/byte-compare.mjs', 'the CSV builders'],
  ['Schema Tools/scripts/lib/deploy-schemas.mjs', 'the publish step'],
  ['Schema Tools/scripts/lib/stale-schema-cleanup.mjs', 'the blog clean-up'],
  ['Schema Tools/scripts/blocks-css/build-blocks-css.mjs', 'the code-block stylesheet'],
  ['Chat AI Bot/api/csv-import.js', 'the database import'],
  ['Chat AI Bot/api/ingest.js', 'the page ingest'],
  ['Chat AI Bot/api/admin.js', 'the ingest refresh'],
  ['Chat AI Bot/api/tools.js', 'the ingest finalize / export'],
  ['AI GEO Audit/scripts/export-09-url-target-keywords.mjs', 'the 09 keywords export'],
  ['apps-dashboard/runner/update-all-runner.mjs', 'the BAU runner'],
];
const BUILTIN = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
const IMPORT_RE = /(?:import\s+(?:[\w*{}\s,$]+\s+from\s+)?|export\s+[\w*{}\s,$]+\s+from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"\n]+)['"]/g;

const pkgName = (spec) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);
function resolveLocal(from, spec) {
  const base = path.resolve(path.dirname(from), spec);
  return [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, path.join(base, 'index.js'), path.join(base, 'index.mjs')]
    .find((p) => fs.existsSync(p) && fs.statSync(p).isFile()) || null;
}
function findUp(dir, test) {
  for (let d = dir; ; d = path.dirname(d)) {
    const hit = test(d);
    if (hit) return hit;
    if (path.dirname(d) === d) return null;
  }
}
const installed = (file, pkg) => !!findUp(path.dirname(file), (d) => fs.existsSync(path.join(d, 'node_modules', pkg, 'package.json')));
function listedIn(file, pkg) {
  const pj = findUp(path.dirname(file), (d) => (fs.existsSync(path.join(d, 'package.json')) ? path.join(d, 'package.json') : null));
  if (!pj) return { listed: false, project: null };
  const j = JSON.parse(fs.readFileSync(pj, 'utf8'));
  const all = { ...j.dependencies, ...j.devDependencies, ...j.optionalDependencies, ...j.peerDependencies };
  return { listed: pkg in all || j.name === pkg, project: path.dirname(pj) };
}

/** Walk one entry's local import graph; collect its package imports. */
function packagesOf(entry, seen, out) {
  if (seen.has(entry) || !fs.existsSync(entry) || /node_modules/.test(entry)) return;
  seen.add(entry);
  const src = fs.readFileSync(entry, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = m[1];
    if (spec.startsWith('.') || spec.startsWith('/')) { const next = resolveLocal(entry, spec); if (next) packagesOf(next, seen, out); continue; }
    if (BUILTIN.has(spec) || BUILTIN.has(pkgName(spec)) || /^(https?:|file:|data:)/.test(spec)) continue;
    out.push({ pkg: pkgName(spec), file: entry });
  }
}

/** { missing: [{ pkg, needed_by, file }], unlisted: [{ pkg, project, needed_by }] } across every entry point. */
export function checkImports(entries = ENTRIES, web = WEB) {
  const missing = new Map(); const unlisted = new Map();
  for (const [rel, label] of entries) {
    const found = [];
    packagesOf(path.join(web, rel), new Set(), found);
    for (const { pkg, file } of found) {
      if (!installed(file, pkg)) { if (!missing.has(pkg)) missing.set(pkg, { pkg, needed_by: new Set(), file: path.relative(web, file) }); missing.get(pkg).needed_by.add(label); continue; }
      const l = listedIn(file, pkg);
      const key = `${l.project}|${pkg}`;
      if (!l.listed) { if (!unlisted.has(key)) unlisted.set(key, { pkg, project: path.relative(web, l.project || ''), needed_by: new Set() }); unlisted.get(key).needed_by.add(label); }
    }
  }
  const plain = (m) => [...m.values()].map((x) => ({ ...x, needed_by: [...x.needed_by] }));
  return { missing: plain(missing), unlisted: plain(unlisted) };
}

/** "Missing code library: playwright (needed by the event, blog and landing page generators). Nothing was run." */
export const missingMessage = (m) => `Missing code library: ${m.pkg} (needed by ${m.needed_by.join(', ')}). Nothing was run.`;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = checkImports();
  console.log(JSON.stringify(r, null, 1));
  process.exit(r.missing.length ? 1 : 0);
}
