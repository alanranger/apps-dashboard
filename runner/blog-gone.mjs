/**
 * F blog posts: the compare step's JSON (it prints none when the generator wrote no files), posts the generator
 * could not build because the page is gone, and which feeds the check used.
 */
import fs from 'node:fs';
import path from 'node:path';

export const EMPTY_COMPARE = { differing: [], new_files: [] };

export function parseCompare(stdout) {
  const s = String(stdout || '');
  const at = s.indexOf('{');
  if (at < 0) return null;
  try { return JSON.parse(s.slice(at)); } catch { return null; }
}

const GONE = new Set([404, 410]);

async function statusOf(url, fetchFn, ua) {
  try {
    const res = await fetchFn(url, { redirect: 'manual', headers: { 'User-Agent': ua }, signal: AbortSignal.timeout(12000) });
    await res.body?.cancel?.().catch(() => {});
    return res.status;
  } catch {
    return 0;
  }
}

/** Listed posts the generator wrote no files for, split into gone (404 / 410) and not built for another reason. */
export async function emptyPosts(posts, urls, { fetchFn = fetch, ua = 'Mozilla/5.0', gapMs = 1000 } = {}) {
  const bySlug = new Map(urls.map((u) => [String(u).replace(/\/+$/, '').split('/').pop(), u]));
  const empty = posts.filter((p) => !p.files?.length).map((p) => bySlug.get(p.slug) || p.slug);
  const gone = [];
  const failed = [];
  for (const [i, url] of empty.entries()) {
    if (i) await new Promise((r) => setTimeout(r, gapMs));
    const status = await statusOf(url, fetchFn, ua);
    if (GONE.has(status)) gone.push(url);
    else failed.push({ url, status });
  }
  return { gone, failed };
}

export const goneCountText = (n) => (n === 1 ? '1 post listed in the feed no longer exists' : `${n} posts listed in the feed no longer exist`);

/** Plain notes for the posts above; every listed post gone means nothing to regenerate. */
export function emptyPostNotes({ gone, failed }, listed, { info, check, problem }) {
  const notes = [];
  if (gone.length) {
    const tail = gone.length === listed ? '; nothing to regenerate' : `; skipped: ${gone.map((u) => u.split('/').pop()).join(', ')}`;
    notes.push(check(`${goneCountText(gone.length)} on the site${tail}.`, 'run A first so the feed is current'));
  }
  failed.forEach((f) => notes.push(problem(`The blog generator wrote nothing for ${f.url} (HTTP ${f.status || 'no answer'}).`, 'resume the run; tell Claude if it repeats')));
  return notes;
}

/** When the feeds were fetched before this run started (seeded from an earlier A check), say which. */
export function feedsNote(sandboxRoot, { info }) {
  const read = (f) => { try { return fs.readFileSync(path.join(sandboxRoot, f), 'utf8').trim(); } catch { return ''; } };
  const fetched = read(path.join('feeds', 'FETCHED-AT.txt'));
  const started = read('.ready');
  if (!fetched || !started || Date.parse(fetched) >= Date.parse(started)) return null;
  const when = new Date(fetched).toLocaleString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  return info(`Using the feeds from the A check at ${when}; run A first for the latest.`);
}
