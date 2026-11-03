/**
 * After a schema publish: does schema.alanranger.com serve EVERY published file as committed? (Live D 93acd8de, 3 Nov:
 * the old check compared one served file with the working-tree copy, which has CRLF line endings under
 * core.autocrlf=true, so it could never match.) Each served body's git blob hash is compared with the committed blob.
 * Fetches bypass caches (?cb= + Cache-Control: no-cache); polled every 15 s for up to 5 min, stopping when all match.
 */
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const SCHEMA_TOOLS = 'G:/Dropbox/alan ranger photography/Website Code/Schema Tools';
const { git, normPath } = await import(pathToFileURL(`${SCHEMA_TOOLS}/scripts/lib/deploy-schemas.mjs`).href);

export const SERVED_BASE = 'https://schema.alanranger.com';
const CONCURRENCY = 8;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** git's blob id for some bytes (what `git hash-object` prints). */
export const blobHash = (buf) => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');

/** file → committed blob id at `commit` (git ls-tree; paths normalised like the deploy module's). */
export function committedBlobs(repo, commit, files) {
  const out = {};
  for (let i = 0; i < files.length; i += 200) {
    const r = git(repo, ['ls-tree', commit, '--', ...files.slice(i, i + 200)]);
    for (const line of r.stdout.split(/\r?\n/).filter(Boolean)) {
      const [meta, name] = line.split('\t');
      out[normPath(name)] = meta.split(/\s+/)[2];
    }
  }
  return out;
}

/** The served file's blob id, or null when it can't be fetched. */
export async function fetchServedBlob(file) {
  const url = `${SERVED_BASE}/${file.split('/').map(encodeURIComponent).join('/')}?cb=${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const res = await fetch(url, { headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' } }).catch(() => null);
  return res?.ok ? blobHash(Buffer.from(await res.arrayBuffer())) : null;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next; next += 1; out[i] = await fn(items[i]); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * want: file → committed blob id. Returns { total, matched, differ: [files still different at the end], polls }.
 * deps (tests): { fetchBlob, intervalMs, timeoutMs, onProgress }.
 */
export async function servedCheck(want, { fetchBlob = fetchServedBlob, intervalMs = 15000, timeoutMs = 300000, onProgress = null } = {}) {
  const files = Object.keys(want);
  const deadline = Date.now() + timeoutMs;
  let pending = files;
  let polls = 0;
  for (;;) {
    polls += 1;
    const seen = await mapLimit(pending, CONCURRENCY, async (f) => [f, await fetchBlob(f)]);
    pending = seen.filter(([f, h]) => h !== want[f]).map(([f]) => f);
    onProgress?.('Checking served files: {done} of {total} match', files.length - pending.length, files.length);
    if (!pending.length || Date.now() + intervalMs > deadline) break;
    await sleep(intervalMs);
  }
  return { total: files.length, matched: files.length - pending.length, differ: pending, polls };
}

/** One line for the step: "served: 52 of 52 match", or which files still differ. */
export function servedText(r, timeoutMs = 300000) {
  if (!r.differ.length) return `served: ${r.matched} of ${r.total} match`;
  const names = r.differ.slice(0, 5).join(', ') + (r.differ.length > 5 ? ` … (+${r.differ.length - 5} more)` : '');
  return `served: ${r.matched} of ${r.total} match after ${Math.round(timeoutMs / 60000)} min; ${r.differ.length} still differ: ${names}`;
}
