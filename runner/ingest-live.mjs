/**
 * LIVE ingest steps 2–4 + Export Mappings: the same deployed Chat AI Bot endpoints bulk-simple.html calls,
 * with the same Bearer INGEST_TOKEN. Not reachable until LIVE is enabled for the ingest steps.
 * Needs INGEST_TOKEN in Chat AI Bot/.env.local.
 */
import fs from 'node:fs';
import { loadEnv } from './store.mjs';

const BASE = 'https://alan-chat-proxy.vercel.app';
const CHAT_ENV = 'G:/Dropbox/alan ranger photography/Website Code/Chat AI Bot/.env.local';
const GAP_MS = 4000;

function token() {
  const t = loadEnv(CHAT_ENV).INGEST_TOKEN;
  if (!t) throw new Error('INGEST_TOKEN missing in Chat AI Bot/.env.local');
  return t;
}

export async function api(pathAndQuery, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${pathAndQuery}`, { method, body: body ? JSON.stringify(body) : undefined,
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${pathAndQuery} -> ${res.status} ${text.slice(0, 200)}`);
  return text;
}

/** Step 2: ingest every URL from the step-1 import (csv_metadata imported in the last 5 minutes), paced. */
async function ingestContent(onProgress) {
  const items = JSON.parse(await api('/api/tools?action=get_urls&recent=true')).urls || [];
  const urls = [...new Set(items.map((i) => i.url).filter(Boolean))];
  const failed = [];
  for (const [i, url] of urls.entries()) {
    onProgress?.('Ingesting page content (step 2) — page {n} of {total}', i, urls.length);
    try { await api('/api/ingest', { method: 'POST', body: { url } }); } catch (e) { failed.push({ url, error: e.message }); }
    await new Promise((r) => setTimeout(r, GAP_MS));
  }
  onProgress?.('Ingesting page content (step 2) — page {n} of {total}', urls.length, urls.length);
  return { urls: urls.length, failed };
}

/** onProgress(label, done, total): the progress window's sub-steps (optional). */
export async function liveIngestSteps({ exportOut, onProgress = null }) {
  const content = await ingestContent(onProgress);
  onProgress?.('Refresh RPCs (admin refresh + finalize, steps 3–4)', 0, 2);
  await api('/api/admin?action=refresh', { method: 'POST' });
  onProgress?.('Refresh RPCs (admin refresh + finalize, steps 3–4)', 1, 2);
  await api('/api/tools?action=finalize', { method: 'POST' });
  onProgress?.('Exporting the 05 event-product mappings', 0, 0);
  const csv = await api('/api/tools?action=export');
  fs.writeFileSync(exportOut, csv);
  return { content, exportRows: Math.max(0, csv.split(/\r?\n/).filter(Boolean).length - 1) };
}
