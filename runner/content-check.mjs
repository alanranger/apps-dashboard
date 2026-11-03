/**
 * B's content check (Alan 3 Nov, option 5): fetch every imported page (HTML only, 6 at a time), fingerprint its main
 * content (content-fingerprint.mjs) and compare with page_content_fingerprints. Only these are fully re-ingested:
 *   new            — the page has never been ingested (not in page_html)
 *   changed        — its main-content fingerprint differs from the stored one
 *   no_fingerprint — ingested before, but no fingerprint stored yet (so the first run re-reads everything once)
 *   check_failed   — the page couldn't be fetched for the check (the ingest tries it itself)
 * Unchanged pages: no new page_html version, no re-embedding; only "checked, unchanged, date" is recorded.
 */
import { contentFingerprint } from './content-fingerprint.mjs';

export const CHECK_CONCURRENCY = 6;
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; AlanRangerBAU/1.0; +https://www.alanranger.com)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const retryAfterMs = (res) => { const s = Number(res.headers.get('retry-after')); return Number.isFinite(s) && s > 0 ? Math.min(s, 120) * 1000 : 30000; };

/** One page's HTML: retried on 429 (honouring Retry-After) and 5xx; a 404 is final. */
export async function fetchPage(url, { tries = 4 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    const res = await fetch(url, { headers: UA, redirect: 'follow' }).catch(() => null);
    if (res?.ok) return { status: res.status, html: await res.text() };
    if (res?.status === 404) return { status: 404, html: null };
    await sleep(res?.status === 429 ? retryAfterMs(res) : 2000 * (i + 1));
  }
  return { status: 0, html: null };
}

export function decide(url, fingerprint, stored, known) {
  if (!fingerprint) return 'check_failed';
  const s = stored.get(url);
  if (!s) return known.has(url) ? 'no_fingerprint' : 'new';
  return s === fingerprint ? 'unchanged' : 'changed';
}

/** stored: Map url → fingerprint; known: Set of urls already in page_html. Returns [{ url, fingerprint, reason, status }]. */
export async function checkPages(urls, { stored, known, fetchPageFn = fetchPage, onProgress = null, concurrency = CHECK_CONCURRENCY }) {
  const out = new Array(urls.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < urls.length) {
      const i = next;
      next += 1;
      const page = await fetchPageFn(urls[i]);
      const fingerprint = page.html ? contentFingerprint(page.html) : null;
      out[i] = { url: urls[i], fingerprint, reason: decide(urls[i], fingerprint, stored, known), status: page.status };
      done += 1;
      onProgress?.('Checking pages: {done} of {total}', done, urls.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
  return out;
}

/** What gets fully re-ingested: everything not unchanged, or every page when Alan forces a full re-read. */
export const reingestList = (results, force = false) => results.filter((r) => force || r.reason !== 'unchanged');

export function planSummary(results, force = false) {
  const byReason = {};
  for (const r of results) byReason[r.reason] = (byReason[r.reason] || 0) + 1;
  const list = reingestList(results, force).map((r) => ({ url: r.url, reason: force && r.reason === 'unchanged' ? 'forced' : r.reason }));
  return { checked: results.length, reingest: list.length, unchanged: byReason.unchanged || 0, by_reason: byReason, force, list };
}

/** Paged reads (PostgREST caps a response at 1000 rows). */
async function readAll(store, table, select, order) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await store.query(`${table}?select=${select}&order=${order}.asc&limit=1000&offset=${offset}`);
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

export async function loadFingerprints(store) {
  return new Map((await readAll(store, 'page_content_fingerprints', 'url,fingerprint', 'url')).map((r) => [r.url, r.fingerprint]));
}

export async function knownPageUrls(store) {
  return new Set((await readAll(store, 'page_html', 'id,url', 'id')).map((r) => r.url));
}

/** LIVE: one row per page — re-ingested pages get changed_at / ingested_at, unchanged ones only checked_at. */
export async function recordFingerprints(store, rows, runId) {
  const now = new Date().toISOString();
  const body = rows.map((r) => (r.ingested
    ? { url: r.url, fingerprint: r.fingerprint, checked_at: now, changed_at: now, ingested_at: now, run_id: runId }
    : { url: r.url, fingerprint: r.fingerprint, checked_at: now, run_id: runId }));
  for (let i = 0; i < body.length; i += 500) {
    const batch = body.slice(i, i + 500);
    const ingested = batch.filter((b) => b.ingested_at);
    const checked = batch.filter((b) => !b.ingested_at);
    for (const part of [ingested, checked].filter((p) => p.length)) {
      await store.query('page_content_fingerprints?on_conflict=url', { method: 'POST', body: part, prefer: 'resolution=merge-duplicates,return=minimal' });
    }
  }
  return body.length;
}
