#!/usr/bin/env node
/**
 * Full-scale proof of the B / H live backup and Undo restore (live B b00c597b timed out, 3 Nov), never touching the real
 * tables: the real affected urls of a dry run, the same REST calls as live (service key, 8 s REST limit), into bau_bk_test2_*.
 * Phases (row counts, checksums and the test disturbance are SQL checks run between them):
 *   --phase backup   real tables only read → bau_bk_test2_<run8>_*; time per table, rows; then a retry must reuse it
 *   --phase src      bau_bk_test2_src_* copies of the real tables (page_chunks / page_html: backed-up urls only)
 *   --phase restore  per-table restore of the copies from the backup (what Undo runs); time per table
 *   --phase drop     drops only the proof tables (bau_bk_test_*, bau_bk_test2_*)
 * Usage: node scripts/proof-bau-backup-full-scale.mjs --run c3fd7897-ae1b-476b-a65b-bad689709b3e --phase backup
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, supabaseStore } from '../runner/store.mjs';
import { affectedUrls, backupParts, liveDbUndo, BACKUP_TABLES, DB_TYPES, TYPE_FILES, runKey } from '../runner/db-live.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (f) => { const i = process.argv.indexOf(f); return i > 0 ? process.argv[i + 1] : null; };
const runId = arg('--run');
if (!runId) throw new Error('--run <dry run id> is required');
const env = loadEnv(path.join(HERE, '..', '.env.local'));
const store = supabaseStore({ url: env.MC_SUPABASE_URL, key: env.MC_SUPABASE_SERVICE_KEY });
const rpc = (fn, args) => store.query(`rpc/${fn}`, { method: 'POST', body: args });
const run8 = runKey(runId);

/** Exactly what live B backs up: urls in the stage's CSVs plus the urls already on record for its types. */
async function affected() {
  const csvDir = path.join('C:/TEMP/update-all', runId, 'alan-shared-resources', 'csv');
  const texts = DB_TYPES.B.map((t) => fs.readFileSync(path.join(csvDir, TYPE_FILES[t]), 'utf8'));
  const existing = (await store.queryAll(`csv_metadata?select=id,url&csv_type=in.(${DB_TYPES.B.join(',')})`)).map((r) => r.url);
  return affectedUrls(texts, existing);
}

async function backupPhase() {
  const urls = await affected();
  const t0 = Date.now();
  const first = await backupParts(run8, urls, rpc, 'proof');
  const total = Date.now() - t0;
  const retry = await backupParts(run8, urls, rpc, 'proof');
  return { affected_urls: urls.length, total_ms: total, ...first, retry_reused: retry.reused };
}

async function srcPhase() {
  const out = {};
  for (const t of BACKUP_TABLES) { const s = Date.now(); out[t] = { rows: await rpc('bau_test2_src', { p_run: run8, p_table: t }), ms: Date.now() - s }; }
  return out;
}

async function restorePhase() {
  const timing = {};
  const deps = { rpc: async (fn, a) => { const s = Date.now(); const r = await rpc(fn, a); timing[a.p_table] = Date.now() - s; return r; } };
  const t0 = Date.now();
  const { restored } = await liveDbUndo(run8, deps, 'proof_restore');
  return { total_ms: Date.now() - t0, timing_ms: timing, restored };
}

const PHASES = { backup: backupPhase, src: srcPhase, restore: restorePhase, drop: () => rpc('bau_test_drop', {}) };
const phase = arg('--phase');
if (!PHASES[phase]) throw new Error(`--phase must be one of ${Object.keys(PHASES).join(', ')}`);
console.log(JSON.stringify({ run8, phase, result: await PHASES[phase]() }, null, 1));
