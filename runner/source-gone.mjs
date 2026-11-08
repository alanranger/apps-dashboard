/**
 * Source evidence for D/E removals (Alan 8 Nov): a product offer (by SKU) or an event (by URL) that is no longer in
 * Squarespace's own export for this run was removed on the website, so losing it from the schema is expected.
 * Anything still in the export (or with no SKU / URL to look up) stays unexplained.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SCHEMA_TOOLS = 'G:/Dropbox/alan ranger photography/Website Code/Schema Tools';
const { readCsvObjects } = await import(pathToFileURL(`${SCHEMA_TOOLS}/scripts/csv-builders/lib.mjs`).href);

/** Exports per stage: [file, keys(row) → identifiers]. An export with fewer rows than MIN_ROWS is treated as broken. */
const SITE = 'https://www.alanranger.com';
const urlPath = (u) => String(u || '').replace(/^https?:\/\/[^/]+/i, '').split(/[?#]/)[0].replace(/\/+$/, '').toLowerCase();
const EXPORTS = {
  D: [['raw-01-products-sqsp-export.csv', (r) => [r.SKU, urlPath(`/${r['Product Page']}/${r['Product URL']}`)]]],
  E: [['02-beginners-photography-lessons.csv', (r) => [urlPath(r.Event_URL)]], ['03-photographic-workshops-near-me.csv', (r) => [urlPath(r.Event_URL)]]]
};
const MIN_ROWS = 5;

const when = (ms) => new Date(ms).toLocaleString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

function readExport(file, keys) {
  if (!fs.existsSync(file)) return null;
  const rows = readCsvObjects(file).rows;
  if (rows.length < MIN_ROWS) return null;
  return { ids: rows.flatMap(keys).filter(Boolean), at: fs.statSync(file).mtimeMs };
}

/** The run's Squarespace exports for a stage: { has(id), label } or null when the stage has none (or one is missing / broken). */
export function sourceExports(csvDir, stage) {
  const list = EXPORTS[stage];
  if (!list) return null;
  const read = list.map(([f, keys]) => readExport(path.join(csvDir, f), keys));
  if (read.some((x) => !x)) return null;
  const ids = new Set(read.flatMap((x) => x.ids));
  return { has: (id) => ids.has(id), label: `${list.map(([f]) => f).join(' + ')}, ${when(Math.max(...read.map((x) => x.at)))}` };
}

const OFFER_PROPS = new Set(['offers', 'price', 'priceSpecification']);

/** What the removal lost that can be looked up in the export: SKUs for offer losses, the page path for a removed node. */
function lostIds(r) {
  if (r.what === 'node removed') return r.url ? [urlPath(r.url)] : [];
  if (!OFFER_PROPS.has(r.prop) && !r.offerType) return [];
  const skus = r.lostSkus || [];
  return skus.length >= (r.from ?? 1) - (r.to ?? 0) ? skus : [];
}

/** Evidence text when everything the removal lost is gone from the export, else null. */
export function goneFromSource(r, source) {
  if (!source) return null;
  const ids = lostIds(r);
  if (!ids.length || ids.some((id) => !id || source.has(id))) return null;
  const what = r.what === 'node removed' ? `${SITE}${ids[0]}` : `SKU ${ids.join(', ')}`;
  return `removed from Squarespace: ${what} is not in its export (${source.label})`;
}
