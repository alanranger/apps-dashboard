/**
 * Dry run of ingest steps 2–4 + Export Mappings with the real Chat AI Bot handlers (api/ingest.js,
 * api/admin.js?action=refresh, api/tools.js?action=finalize|export) against the recording mock.
 * Nothing reaches the database. Step 2 scrapes a small paced sample (live GETs only).
 * Run: node --import ./register.mjs run-dry-ingest-steps.mjs
 * Env: DRY_SNAPSHOT (csv_metadata/page_entities/v_events_for_chat snapshot), SAMPLE_URLS (comma list),
 *      EXPORT_OUT (where the export CSV is written), REPORT (report path).
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resetDryRun } from './supabase-mock.mjs';

const API = 'G:/Dropbox/alan ranger photography/Website Code/Chat AI Bot/api';
process.env.SUPABASE_URL = 'https://dry-run.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'dry-run';
process.env.INGEST_TOKEN = 'dry-run-token';
const load = async (name) => (await import(pathToFileURL(`${API}/${name}.js`).href)).default;
const [ingest, admin, tools] = [await load('ingest'), await load('admin'), await load('tools')];

function call(handler, { method = 'POST', query = {}, body = {} }) {
  return new Promise((resolve) => {
    let status = 0; const headers = {};
    const res = {
      setHeader(k, v) { headers[k.toLowerCase()] = v; }, getHeader(k) { return headers[k.toLowerCase()]; },
      status(c) { status = c; return this; }, statusCode: 200,
      send(s) { resolve({ status: status || this.statusCode, headers, body: s }); },
      json(o) { resolve({ status: status || this.statusCode, headers, body: o }); },
      end(s) { resolve({ status: status || this.statusCode, headers, body: s }); }
    };
    Promise.resolve(handler({ method, query, body, headers: { authorization: 'Bearer dry-run-token' } }, res))
      .catch((e) => resolve({ status: 500, body: { error: String(e?.message || e) } }));
  });
}

const tally = (writes) => writes.reduce((m, w) => ({ ...m, [`${w.op}:${w.table}`]: (m[`${w.op}:${w.table}`] || 0) + (w.rows?.length || w.affected?.length || 1) }), {});
function duplicateEntities() {
  const seen = new Map();
  for (const e of globalThis.__DRYRUN__.tables.page_entities || []) {
    const k = `${e.url}|${e.kind}|${e.date_start || ''}`;
    seen.set(k, (seen.get(k) || 0) + 1);
  }
  return [...seen].filter(([, n]) => n > 1).map(([k]) => k);
}

resetDryRun(process.env.DRY_SNAPSHOT);
const before = duplicateEntities();
const report = { steps: [], duplicates_already_in_db: before };
for (const url of (process.env.SAMPLE_URLS || '').split(',').filter(Boolean)) {
  const r = await call(ingest, { body: { url } });
  const b = typeof r.body === 'string' ? JSON.parse(r.body) : r.body;
  report.steps.push({ step: 'content (api/ingest)', url, status: r.status, ok: b?.ok, entities: b?.entities ?? b?.entitiesCount ?? null });
  await new Promise((res) => setTimeout(res, 4000));
}
const afterContent = globalThis.__DRYRUN__.writes.length;
const map = await call(admin, { query: { action: 'refresh' } });
report.steps.push({ step: 'mappings (api/admin?action=refresh)', status: map.status });
const fin = await call(tools, { query: { action: 'finalize' } });
report.steps.push({ step: 'finalize (api/tools?action=finalize)', status: fin.status, note: 'its internal /api/refresh-mappings calls are not exercised locally' });
const exp = await call(tools, { method: 'GET', query: { action: 'export' } });
const csv = typeof exp.body === 'string' ? exp.body : '';
if (process.env.EXPORT_OUT && csv) fs.writeFileSync(process.env.EXPORT_OUT, csv);
report.steps.push({ step: 'export mappings (api/tools?action=export)', status: exp.status, rows: Math.max(0, csv.split('\n').filter(Boolean).length - 1), written: process.env.EXPORT_OUT || null });
report.writes_content = tally(globalThis.__DRYRUN__.writes.slice(0, afterContent));
report.writes_after = tally(globalThis.__DRYRUN__.writes.slice(afterContent));
report.duplicate_page_entities = duplicateEntities().filter((k) => !before.includes(k)).length;
fs.writeFileSync(process.env.REPORT, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
