/**
 * Stages B / H LIVE (Claude/Alan approved design + step 5). Before the first database write the run takes an automatic
 * backup — bau_bk_<run8>_<table> (full: csv_metadata, page_entities, event_product_links_auto; affected urls only:
 * page_chunks, page_html) — then sends the dry run's CSVs through the deployed Chat AI Bot endpoints bulk-simple.html
 * uses. If the backup fails, nothing is written. Undo = bau_restore(<run8>) + the same refresh RPCs (admin refresh, finalize).
 */
import fs from 'node:fs';
import path from 'node:path';
import { api } from './ingest-live.mjs';

export const TYPE_FILES = {
  blog: '01-blog-posts.csv', course_events: '02-beginners-photography-lessons.csv', workshop_events: '03-photographic-workshops-near-me.csv',
  course_products: '04-photography-services-courses-mentoring.csv', workshop_products: '05-photo-workshops-uk-landscape.csv',
  landing_service_pages: '08-landing-and-service-pages.csv', product_schema: '07-product-schema-with-review-ratings.csv'
};
const B_TYPES = ['blog', 'course_events', 'workshop_events', 'course_products', 'workshop_products', 'landing_service_pages'];
export const DB_TYPES = { B: B_TYPES, H: [...B_TYPES, 'product_schema'] };

/** The run's backup key: 8 lowercase letters/digits from its id (bau_bk_<run8>_<table>). */
export const runKey = (runId) => String(runId).replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 8);

/** Every site url the import can touch: the urls in the CSVs being imported, plus those already on record for those types. */
export function affectedUrls(csvTexts, existingUrls = []) {
  const found = csvTexts.flatMap((t) => String(t).match(/https:\/\/www\.alanranger\.com\/[^",\s]*/g) || []);
  return [...new Set([...found, ...existingUrls].map((u) => u.replace(/\/+$/, '')).filter(Boolean))];
}

/** Step 1 of bulk-simple.html: one CSV type into the chat database (same endpoint, same Bearer INGEST_TOKEN). */
export async function csvImport(csvType, csvData) {
  const text = await api('/api/csv-import', { method: 'POST', body: { contentType: 'metadata', csvType, csvData } });
  try { return JSON.parse(text); } catch { return { raw: text.slice(0, 200) }; }
}

/** Ingest step 3 + 4 (the refresh RPCs): also what Undo runs after the restore. */
export async function refreshAndFinalize() {
  await api('/api/admin?action=refresh', { method: 'POST' });
  await api('/api/tools?action=finalize', { method: 'POST' });
  return 'admin refresh + finalize';
}

/**
 * Backup, then import every type of the stage. deps (tests inject fakes): { rpc(fn, args), importFn(type, csv) }.
 * Returns { run8, backup, imported, urls }.
 */
export async function liveDbIngest({ stage, csvDir, runId, existingUrls = [] }, deps) {
  const types = DB_TYPES[stage];
  const texts = Object.fromEntries(types.map((t) => [t, fs.readFileSync(path.join(csvDir, TYPE_FILES[t]), 'utf8')]));
  const urls = affectedUrls(Object.values(texts), existingUrls);
  const run8 = runKey(runId);
  const backup = await deps.rpc('bau_backup', { p_run: run8, p_urls: urls });
  const imported = {};
  for (const t of types) imported[t] = await deps.importFn(t, texts[t]);
  return { run8, backup, imported, urls: urls.length };
}

/** Undo B / H: restore the run's backup exactly, then the same refresh RPCs. deps: { rpc, refreshFn }. */
export async function liveDbUndo(run8, deps) {
  const restored = await deps.rpc('bau_restore', { p_run: run8 });
  return { restored, refreshed: await deps.refreshFn() };
}
