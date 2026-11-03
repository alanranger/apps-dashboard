#!/usr/bin/env node
/**
 * Step-5 restore proof (Claude 3 Nov): bau_backup / bau_restore on bau_bk_test_src_* 5-row sample copies — never the
 * real tables. Backup → change / delete / add rows in every table → restore → every table identical (md5 of all rows).
 *   node scripts/proof-bau-restore.mjs
 */
import path from 'node:path';
import { loadEnv, supabaseStore } from '../runner/store.mjs';

const env = loadEnv(path.resolve('.env.local'));
const store = supabaseStore({ url: env.MC_SUPABASE_URL, key: env.MC_SUPABASE_SERVICE_KEY });
const rpc = (fn, args = {}) => store.query(`rpc/${fn}`, { method: 'POST', body: args });
const RUN = 'proof001';
const TABLES = { csv_metadata: ['id', 'title'], page_entities: ['id', 'title'], event_product_links_auto: ['event_url', 'method'], page_chunks: ['id', 'title'], page_html: ['id', 'content_hash'] };
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });
const src = (t) => `bau_bk_test_src_${t}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** PostgREST sees new tables after its schema cache reloads (a DDL event); retry briefly. */
async function rows(table, q = 'select=*') {
  for (let i = 0; ; i += 1) {
    try { return await store.query(`${table}?${q}`); } catch (e) { if (i > 10) throw e; await store.query('rpc/bau_test_setup', { method: 'HEAD' }).catch(() => {}); await sleep(3000); }
  }
}
const fingerprints = async () => Object.fromEntries(await Promise.all(Object.keys(TABLES).map(async (t) => [t, await rpc('bau_table_fingerprint', { p_table: src(t) })])));

/** In every sample table: change one row, delete one row, add one new row (same url for the url-scoped tables). */
async function mutate() {
  for (const [t, [pk, col]] of Object.entries(TABLES)) {
    const all = await rows(src(t), `select=*&order=${pk}.asc`);
    const [a, b, c] = all;
    await store.query(`${src(t)}?${pk}=eq.${encodeURIComponent(a[pk])}`, { method: 'PATCH', body: { [col]: `CHANGED BY PROOF ${Date.now()}` }, prefer: 'return=minimal' });
    if (b) await store.query(`${src(t)}?${pk}=eq.${encodeURIComponent(b[pk])}`, { method: 'DELETE', prefer: 'return=minimal' });
    // A row an ingest would add: new key; full tables a new url, url-scoped tables the same url with new content.
    const base = c || a;
    const added = { ...base, [pk]: pk === 'id' ? Number(base.id) + 900000000 : `${base[pk]}#added-by-proof` };
    if (['csv_metadata', 'page_entities'].includes(t)) added.url = `${base.url}#added-by-proof`;
    for (const h of ['chunk_hash', 'hash', 'content_hash', 'entity_hash']) if (h in added && added[h] != null) added[h] = `proof-${Date.now()}`;
    await store.query(src(t), { method: 'POST', body: added, prefer: 'return=minimal' });
  }
}

try {
  await rpc('bau_test_drop');
  const setup = await rpc('bau_test_setup');
  check('5-row sample copies created (bau_bk_test_src_*), real tables only read', Object.values(setup).every((n) => n > 0), JSON.stringify(setup));
  const before = await fingerprints();
  const urls = [...new Set([...(await rows(src('page_chunks'), 'select=url')), ...(await rows(src('page_html'), 'select=url'))].map((r) => r.url))];
  const backup = await rpc('bau_backup', { p_run: RUN, p_urls: urls, p_test: true });
  check('backup tables written (bau_bk_test_proof001_*) with every sample row', Object.keys(TABLES).every((t) => backup[`bau_bk_test_${RUN}_${t}`] === setup[src(t)]), JSON.stringify(backup));
  await mutate();
  const changed = await fingerprints();
  check('every sample table really changed (row changed, deleted, added)', Object.keys(TABLES).every((t) => changed[t] !== before[t]));
  const restored = await rpc('bau_restore', { p_run: RUN, p_test: true });
  const after = await fingerprints();
  check('restore: every table identical to before the changes (md5 of all rows)', Object.keys(TABLES).every((t) => after[t] === before[t]), JSON.stringify(restored));
  check('restore removed exactly the 1 added row per table and restored every backed-up row',
    Object.keys(TABLES).every((t) => restored[t].removed_since_backup === 1 && restored[t].restored === setup[src(t)]), JSON.stringify(restored));
  const dropped = await rpc('bau_test_drop');
  check('test tables removed (bau_bk_test_* only)', dropped >= 11, `${dropped} dropped`);
} catch (e) {
  check('proof ran to the end', false, e.message);
}
const pass = results.every((r) => r.ok);
console.log(JSON.stringify({ pass, results: results.map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok ? '' : ` :: ${r.detail}`}`), detail: results.map((r) => r.detail) }, null, 2));
process.exitCode = pass ? 0 : 1;
