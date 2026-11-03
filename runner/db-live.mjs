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

/** Backup / restore order: csv_metadata first (page_chunks / page_entities reference it). */
export const BACKUP_TABLES = ['csv_metadata', 'page_entities', 'event_product_links_auto', 'page_chunks', 'page_html'];
/** page_html is ~110 KB a row (several versions per url): copied in url chunks so no call carries the whole 300+ MB. */
export const HTML_URL_CHUNK = 40;
const chunks = (list, size) => Array.from({ length: Math.ceil(list.length / size) || 1 }, (_, i) => list.slice(i * size, (i + 1) * size));

/**
 * One call per table (page_html per url chunk); every call is idempotent, so a retry completes a partial backup.
 * A finished backup (bau_backup_done) is never retaken: on Resume it is still the state before the first write.
 * Returns { backup: { table: rows }, timing_ms: { table: ms }, reused }.
 */
export async function backupParts(run8, urls, rpc, mode = 'live', onProgress = null) {
  if (await rpc('bau_backup_done', { p_run: run8, p_mode: mode })) return { backup: {}, timing_ms: {}, reused: true };
  const call = (table, list) => rpc('bau_backup_part', { p_run: run8, p_table: table, p_urls: list, p_mode: mode });
  const backup = {};
  const timing = {};
  const u = await call('urls', urls);
  backup[u.table] = u.rows;
  for (const [i, t] of BACKUP_TABLES.entries()) {
    const t0 = Date.now();
    const lists = t === 'page_html' ? chunks(urls, HTML_URL_CHUNK) : [urls];
    let r = null;
    for (const [c, list] of lists.entries()) {
      onProgress?.(lists.length > 1 ? `Backing up ${t} — chunk {n} of {total}` : `Backing up ${t} (table {n} of {total})`, lists.length > 1 ? c : i, lists.length > 1 ? lists.length : BACKUP_TABLES.length);
      r = await call(t, list);
    }
    backup[r.table] = r.rows;
    timing[t] = Date.now() - t0;
  }
  await rpc('bau_backup_done', { p_run: run8, p_mode: mode, p_set: true });
  return { backup, timing_ms: timing, reused: false };
}

/**
 * Backup, then import every type of the stage. deps (tests inject fakes): { rpc(fn, args), importFn(type, csv) }.
 * If any backup call fails nothing is imported. Returns { run8, backup, timing_ms, reused, imported, urls }.
 */
export async function liveDbIngest({ stage, csvDir, runId, existingUrls = [] }, deps) {
  const types = DB_TYPES[stage];
  const texts = Object.fromEntries(types.map((t) => [t, fs.readFileSync(path.join(csvDir, TYPE_FILES[t]), 'utf8')]));
  const urls = affectedUrls(Object.values(texts), existingUrls);
  const run8 = runKey(runId);
  const { backup, timing_ms: timingMs, reused } = await backupParts(run8, urls, deps.rpc, 'live', deps.onProgress);
  const imported = {};
  for (const [i, t] of types.entries()) {
    deps.onProgress?.(`Importing ${t.replace(/_/g, ' ')} ({n} of {total} file types)`, i, types.length);
    imported[t] = await deps.importFn(t, texts[t]);
  }
  return { run8, backup, timing_ms: timingMs, reused, imported, urls: urls.length };
}

/** Undo B / H: restore the run's backup exactly, one table per call, then the same refresh RPCs. deps: { rpc, refreshFn }. */
export async function liveDbUndo(run8, deps, mode = 'live') {
  const restored = {};
  for (const [i, t] of BACKUP_TABLES.entries()) {
    deps.onProgress?.(`Restoring ${t} ({n} of {total} tables)`, i, BACKUP_TABLES.length);
    restored[t] = await deps.rpc('bau_restore_part', { p_run: run8, p_table: t, p_mode: mode });
  }
  deps.onProgress?.('Refresh RPCs (admin refresh + finalize)', 0, 0);
  return { restored, refreshed: deps.refreshFn ? await deps.refreshFn() : null };
}
