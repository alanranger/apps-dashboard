import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { liveDbIngest, liveDbUndo, affectedUrls, runKey, DB_TYPES, TYPE_FILES } from '../../runner/db-live.mjs';

function csvDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bau-db-test-'));
  for (const t of DB_TYPES.H) fs.writeFileSync(path.join(dir, TYPE_FILES[t]), `Title,Full Url\n${t},https://www.alanranger.com/${t}/page\n`);
  return dir;
}

/** Fake database: bau_backup_done is false until set; each bau_backup_part returns its table and a row count. */
function fakeRpc(calls, { done = false } = {}) {
  let finished = done;
  return async (fn, args) => {
    calls.push(['rpc', fn, args]);
    if (fn === 'bau_backup_done') { finished = finished || !!args.p_set; return finished; }
    return { table: `bau_bk_${args.p_run}_${args.p_table}`, rows: 7 };
  };
}

test('B live: the backup is taken BEFORE the first database write, one call per table, with every affected url', async () => {
  const calls = [];
  const deps = { rpc: fakeRpc(calls), importFn: async (t) => { calls.push(['import', t]); return { ok: true }; } };
  const r = await liveDbIngest({ stage: 'B', csvDir: csvDir(), runId: 'AB12CD34-ffff', existingUrls: ['https://www.alanranger.com/old-page/'] }, deps);
  const firstImport = calls.findIndex((c) => c[0] === 'import');
  const backup = calls.slice(0, firstImport).filter((c) => c[1] === 'bau_backup_part');
  assert.deepEqual(backup.map((c) => c[2].p_table), ['urls', 'csv_metadata', 'page_entities', 'event_product_links_auto', 'page_chunks', 'page_html']);
  assert.ok(backup.every((c) => c[2].p_run === 'ab12cd34' && c[2].p_mode === 'live'));
  assert.ok(backup[0][2].p_urls.includes('https://www.alanranger.com/old-page'), 'urls already on record are backed up too');
  assert.deepEqual(calls[firstImport - 1].slice(1, 2), ['bau_backup_done'], 'the backup is marked finished before any import');
  assert.equal(calls[firstImport - 1][2].p_set, true);
  assert.deepEqual(calls.slice(firstImport).map((c) => c[1]), DB_TYPES.B, 'then each B type is imported, in order');
  assert.equal(r.run8, 'ab12cd34');
  assert.equal(r.reused, false);
});

test('backup at scale: page_html goes in url chunks; a finished backup is reused on retry, never retaken', async () => {
  const { backupParts, HTML_URL_CHUNK } = await import('../../runner/db-live.mjs');
  const urls = Array.from({ length: HTML_URL_CHUNK * 2 + 5 }, (_, i) => `https://www.alanranger.com/p${i}`);
  const calls = [];
  await backupParts('ab12cd34', urls, fakeRpc(calls));
  const html = calls.filter((c) => c[2]?.p_table === 'page_html');
  assert.equal(html.length, 3);
  assert.deepEqual(html.flatMap((c) => c[2].p_urls), urls, 'every url once, in order');
  const again = [];
  const r = await backupParts('ab12cd34', urls, fakeRpc(again, { done: true }));
  assert.equal(r.reused, true);
  assert.deepEqual(again.map((c) => c[1]), ['bau_backup_done'], 'nothing copied again');
});

test('B / H live: if the backup fails, nothing is written', async () => {
  let imports = 0;
  const deps = { rpc: async () => { throw new Error('backup failed'); }, importFn: async () => { imports += 1; } };
  await assert.rejects(liveDbIngest({ stage: 'H', csvDir: csvDir(), runId: 'run-1' }, deps), /backup failed/);
  assert.equal(imports, 0);
});

test('H imports the product schema (07) as well; undo restores the backup, then re-runs the refresh', async () => {
  assert.deepEqual(DB_TYPES.H.slice(-1), ['product_schema']);
  const order = [];
  const r = await liveDbUndo('ab12cd34', { rpc: async (fn, a) => { order.push(`${fn}:${a.p_table}`); return { restored: 1003 }; }, refreshFn: async () => { order.push('refresh'); return 'ok'; } });
  assert.deepEqual(order, ['bau_restore_part:csv_metadata', 'bau_restore_part:page_entities', 'bau_restore_part:event_product_links_auto',
    'bau_restore_part:page_chunks', 'bau_restore_part:page_html', 'refresh']);
  assert.equal(r.restored.csv_metadata.restored, 1003);
});

test('affected urls: from the CSVs and the existing rows, de-duplicated without trailing slashes; run key is 8 lowercase characters', () => {
  assert.deepEqual(affectedUrls(['a,https://www.alanranger.com/x/\nb,"https://www.alanranger.com/y"'], ['https://www.alanranger.com/x']),
    ['https://www.alanranger.com/x', 'https://www.alanranger.com/y']);
  assert.equal(runKey('0F49CBC9-6beb-4921'), '0f49cbc9');
});

test('undo: only the stage latest live publish, once; B/H undo restores the backup then refreshes', async () => {
  const { undoRefusal, undoStage } = await import('../../runner/undo-live.mjs');
  const live = { run_id: 'run-9', status: 'ok', commit: 'abc1234', backup_run: null };
  assert.equal(undoRefusal('F', live, 'run-9'), null);
  assert.match(undoRefusal('F', live, 'run-8'), /latest live run/);
  assert.match(undoRefusal('F', { ...live, undo_of: 'run-7' }, 'run-9'), /already an undo/);
  assert.match(undoRefusal('B', { run_id: 'run-9', status: 'ok' }, 'run-9'), /nothing to undo/);
  const calls = [];
  const out = await undoStage('B', { run_id: 'run-9', backup_run: 'ab12cd34' }, 'undo-1',
    { rpc: async (fn, a) => { calls.push(`${fn}:${a.p_run}`); return {}; }, refreshFn: async () => { calls.push('refresh'); return 'ok'; } });
  assert.deepEqual(calls, [...Array(5).fill('bau_restore_part:ab12cd34'), 'refresh']);
  assert.equal(out.files, null, 'B has no file commit to reverse here');
});
