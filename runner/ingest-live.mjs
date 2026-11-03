/**
 * LIVE ingest steps 2–4 + Export Mappings: the same deployed Chat AI Bot endpoints bulk-simple.html calls,
 * with the same Bearer INGEST_TOKEN. Not reachable until LIVE is enabled for the ingest steps.
 * Needs INGEST_TOKEN in Chat AI Bot/.env.local.
 */
import fs from 'node:fs';
import { loadEnv } from './store.mjs';
import { checkPages, knownPageUrls, loadFingerprints, planSummary, recordFingerprints, reingestList } from './content-check.mjs';

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

/**
 * Step 2 (Alan 3 Nov, option 5): check every URL from the step-1 import, then fully re-ingest only the pages that are
 * new, changed or have no fingerprint yet (all of them when force). Unchanged pages: "checked, unchanged" only.
 */
async function ingestContent(onProgress, { store, runId, force = false }) {
  const items = JSON.parse(await api('/api/tools?action=get_urls&recent=true')).urls || [];
  const urls = [...new Set(items.map((i) => i.url).filter(Boolean))];
  const [stored, known] = await Promise.all([loadFingerprints(store), knownPageUrls(store)]);
  const results = await checkPages(urls, { stored, known, onProgress });
  const todo = reingestList(results, force);
  const failed = [];
  const ingested = new Set();
  for (const [i, r] of todo.entries()) {
    onProgress?.('Re-ingesting changed pages: {done} of {total}', i, todo.length);
    try { await api('/api/ingest', { method: 'POST', body: { url: r.url } }); ingested.add(r.url); } catch (e) { failed.push({ url: r.url, error: e.message }); }
    await new Promise((res) => setTimeout(res, GAP_MS));
  }
  onProgress?.('Re-ingesting changed pages: {done} of {total}', todo.length, todo.length);
  const record = results.filter((r) => r.fingerprint && (ingested.has(r.url) || (!force && r.reason === 'unchanged')))
    .map((r) => ({ url: r.url, fingerprint: r.fingerprint, ingested: ingested.has(r.url) }));
  await recordFingerprints(store, record, runId);
  return { urls: urls.length, plan: planSummary(results, force), reingested: ingested.size, failed };
}

/** onProgress(label, done, total): the progress window's sub-steps (optional). content: { store, runId, force }. */
export async function liveIngestSteps({ exportOut, onProgress = null, content: opts }) {
  const content = await ingestContent(onProgress, opts);
  onProgress?.('Refresh RPCs (admin refresh + finalize, steps 3–4)', 0, 2);
  await api('/api/admin?action=refresh', { method: 'POST' });
  onProgress?.('Refresh RPCs (admin refresh + finalize, steps 3–4)', 1, 2);
  await api('/api/tools?action=finalize', { method: 'POST' });
  onProgress?.('Exporting the 05 event-product mappings', 0, 0);
  const csv = await api('/api/tools?action=export');
  fs.writeFileSync(exportOut, csv);
  return { content, exportRows: Math.max(0, csv.split(/\r?\n/).filter(Boolean).length - 1) };
}
