/**
 * Dry-run the real Chat AI Bot metadata ingest (api/csv-import.js) against a production snapshot,
 * once with the manual CSVs and once with the test CSVs, and diff every write it would make.
 * Run: node --import ./register.mjs run-dry-ingest.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import { resetDryRun } from './supabase-mock.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIVE = process.env.LIVE_CSV_DIR || 'G:/Dropbox/alan ranger photography/Website Code/alan-shared-resources/csv';
// TEST_DIR (required) / DRY_TYPES (comma list) / REPORT (path) / DRY_SNAPSHOT (production read snapshot JSON).
const TEST = process.env.TEST_DIR;
if (!TEST) throw new Error('TEST_DIR is required');
const SNAP = process.env.DRY_SNAPSHOT || path.join(HERE, 'prod-snapshot.json');
const HANDLER = pathToFileURL('G:/Dropbox/alan ranger photography/Website Code/Chat AI Bot/api/csv-import.js').href;

const ALL_TYPES = [
  ['blog', '01-blog-posts.csv'], ['course_events', '02-beginners-photography-lessons.csv'],
  ['workshop_events', '03-photographic-workshops-near-me.csv'], ['course_products', '04-photography-services-courses-mentoring.csv'],
  ['workshop_products', '05-photo-workshops-uk-landscape.csv'], ['landing_service_pages', '08-landing-and-service-pages.csv'],
  ['product_schema', '07-product-schema-with-review-ratings.csv']
];
const wanted = (process.env.DRY_TYPES || '').split(',').filter(Boolean);
const TYPES = wanted.length ? ALL_TYPES.filter(([t]) => wanted.includes(t)) : ALL_TYPES.filter(([t]) => t !== 'product_schema');

process.env.SUPABASE_URL = 'https://dry-run.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'dry-run';
process.env.INGEST_TOKEN = process.env.INGEST_TOKEN || 'dry-run-token';
const { default: handler } = await import(HANDLER);

async function runOne(csvType, file) {
  const req = { method: 'POST', body: { contentType: 'metadata', csvType, csvData: fs.readFileSync(file, 'utf8') },
    headers: { authorization: `Bearer ${process.env.INGEST_TOKEN}` } };
  let status = 0; let payload = null;
  const res = { setHeader() {}, status(c) { status = c; return this; }, send(s) { payload = typeof s === 'string' ? JSON.parse(s) : s; } };
  await handler(req, res);
  return { status, payload };
}

const VOLATILE = new Set(['import_session', 'id', 'created_at', 'updated_at', 'last_seen']);
const stable = (r) => JSON.stringify(Object.fromEntries(Object.entries(r).filter(([k]) => !VOLATILE.has(k)).sort()));

function summarise(writes) {
  const inserts = writes.filter((w) => w.op === 'insert' || w.op === 'upsert').flatMap((w) => w.rows.map((r) => `${w.table}|${stable(r)}`));
  const deletes = writes.filter((w) => w.op === 'delete').flatMap((w) => w.affected.map((r) => `${w.table}|${r.csv_type || r.kind || ''}|${r.url}|${r.start_date || r.date_start || ''}`));
  const updates = writes.filter((w) => w.op === 'update').flatMap((w) => w.affected.map((r) => `${w.table}|${r.id}|${JSON.stringify(w.patch)}`));
  return { inserts: inserts.sort(), deletes: deletes.sort(), updates: updates.sort() };
}

function duplicates(list) {
  const seen = new Map();
  list.forEach((k) => seen.set(k, (seen.get(k) || 0) + 1));
  return [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k);
}

const hash = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 16);
const report = [];
for (const [csvType, file] of TYPES) {
  resetDryRun(SNAP);
  const manual = await runOne(csvType, path.join(LIVE, file));
  const mw = summarise(globalThis.__DRYRUN__.writes);
  const metaAfterManual = globalThis.__DRYRUN__.tables.csv_metadata.filter((r) => r.csv_type === (manual.payload?.csv_type || csvType));
  resetDryRun(SNAP);
  const test = await runOne(csvType, path.join(TEST, file));
  const tw = summarise(globalThis.__DRYRUN__.writes);
  const metaAfterTest = globalThis.__DRYRUN__.tables.csv_metadata.filter((r) => r.csv_type === (test.payload?.csv_type || csvType));
  const onlyIn = (a, b) => a.filter((x) => !b.includes(x));
  const metaKeys = (rows) => rows.map((r) => `${r.url}|${r.start_date || ''}`);
  report.push({
    csvType, file, input_sha_manual: hash(path.join(LIVE, file)), input_sha_test: hash(path.join(TEST, file)),
    status: `${manual.status}/${test.status}`, imported: `${manual.payload?.metadata_imported ?? manual.payload?.count}/${test.payload?.metadata_imported ?? test.payload?.count}`,
    rows_after: `${metaAfterManual.length}/${metaAfterTest.length}`,
    new_rows_vs_manual: onlyIn(metaKeys(metaAfterTest), metaKeys(metaAfterManual)).length,
    duplicates_test: duplicates(metaKeys(metaAfterTest)).length,
    insert_payload_diffs: { only_manual: onlyIn(mw.inserts, tw.inserts).length, only_test: onlyIn(tw.inserts, mw.inserts).length },
    delete_diffs: { only_manual: onlyIn(mw.deletes, tw.deletes).length, only_test: onlyIn(tw.deletes, mw.deletes).length },
    update_diffs: { only_manual: onlyIn(mw.updates, tw.updates).length, only_test: onlyIn(tw.updates, mw.updates).length },
    differing_urls: [...new Set(onlyIn(tw.inserts, mw.inserts).map((s) => (s.match(/"url":"([^"]+)"/) || [])[1]))].slice(0, 12)
  });
}
fs.writeFileSync(process.env.REPORT || path.join(TEST, 'dry-ingest-report.json'), JSON.stringify(report, null, 2));
for (const r of report) console.log(JSON.stringify(r));
