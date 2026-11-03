#!/usr/bin/env node
/**
 * Optional (Alan decides): seed page_content_fingerprints from each page's LATEST stored page_html version, so the
 * next live B re-reads only pages changed since then instead of all ~520 once. Today's live B (9f01bcfd, 3 Nov
 * 17:25–18:35) re-ingested every B page, so the latest versions reflect the current content.
 * Read-only by default (prints what it would store); --write upserts. Never touches page_html.
 *   node scripts/seed-content-fingerprints.mjs [--write]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, supabaseStore } from '../runner/store.mjs';
import { contentFingerprint } from '../runner/content-fingerprint.mjs';
import { recordFingerprints } from '../runner/content-check.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const env = loadEnv(path.join(HERE, '..', '.env.local'));
const store = supabaseStore({ url: env.MC_SUPABASE_URL, key: env.MC_SUPABASE_SERVICE_KEY });
const write = process.argv.includes('--write');

const ids = [];
for (let offset = 0; ; offset += 1000) {
  // updated_at: a re-ingest with identical HTML refreshes the existing row instead of adding one.
  const page = await store.query(`page_html?select=id,url,created_at:updated_at&order=updated_at.desc.nullslast&limit=1000&offset=${offset}`);
  ids.push(...page);
  if (page.length < 1000) break;
}
const latest = new Map();
for (const r of ids) if (!latest.has(r.url)) latest.set(r.url, r);
const rows = [];
for (const r of latest.values()) {
  const [{ html_content: html }] = await store.query(`page_html?select=html_content&id=eq.${r.id}`);
  rows.push({ url: r.url, fingerprint: contentFingerprint(html), ingested: false, at: r.created_at });
}
console.log(`${rows.length} pages: latest stored versions from ${rows.map((r) => r.at).sort()[0]} to ${rows.map((r) => r.at).sort().at(-1)}`);
if (write) console.log('stored', await recordFingerprints(store, rows, null), 'fingerprints');
else console.log('read-only: run with --write to store them');
