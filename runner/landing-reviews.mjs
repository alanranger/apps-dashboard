/**
 * Stage G pre-publish check (Alan 5 Nov): every review a landing / service schema carries must be visible on the live
 * page (author + text), and the rating or count the page shows must match aggregateRating. Warn only; never blocks.
 */
import fs from 'node:fs';
import path from 'node:path';

const ENTITIES = { amp: '&', quot: '"', apos: "'", nbsp: ' ', rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', mdash: '-', ndash: '-', hellip: '...' };

/** Page text as a reader sees it: no scripts / styles / tags, entities decoded, quotes and spaces normalised, lower case. */
export function visibleText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ').toLowerCase();
}

const norm = (s) => visibleText(String(s || '')).trim();
const nameOf = (a) => (typeof a === 'string' ? a : a?.name || '');

/** Pages in a schema file whose node carries review / aggregateRating: { url, agg, reviews: [{ author, text }] }. */
export function reviewedPages(json) {
  const out = [];
  const walk = (o) => {
    if (Array.isArray(o)) return o.forEach(walk);
    if (!o || typeof o !== 'object') return undefined;
    if (o.review || o.aggregateRating) {
      const reviews = [].concat(o.review || []).map((r) => ({ author: nameOf(r.author), text: String(r.reviewBody || r.description || '') }));
      out.push({ url: String(o.url || o['@id'] || '').split('#')[0], agg: o.aggregateRating || null, reviews });
    }
    return Object.values(o).forEach(walk);
  };
  walk(json);
  return out.filter((p) => p.url);
}

/** "5.0 out of 5 from 4 reviews" as shown on the page, or null. */
function shownRating(text) {
  const m = text.match(/(\d(?:\.\d)?)\s*out of\s*5\s*(?:from|based on)\s*(\d+)\s*reviews?/);
  return m ? { value: Number(m[1]), count: Number(m[2]) } : null;
}

/** The page's "X out of 5 from N reviews" must equal aggregateRating; without that line, "N reviews" must be on the page. */
function ratingIssue(agg, text) {
  if (!agg) return null;
  const want = { value: Number(agg.ratingValue), count: Number(agg.reviewCount ?? agg.ratingCount) };
  const label = `${want.value} from ${want.count} reviews`;
  const shown = shownRating(text);
  if (!shown) return new RegExp(`\\b${want.count} reviews?\\b`).test(text) ? null : `the schema rating (${label}) isn't shown on the page`;
  if (Math.abs(shown.value - want.value) > 0.05 || shown.count !== want.count) return `the schema rating (${label}) doesn't match the page (${shown.value} from ${shown.count} reviews)`;
  return null;
}

/** Reviews whose author or opening words aren't on the page, and any rating mismatch. */
export function checkReviews(page, html) {
  const text = visibleText(html);
  const missing = page.reviews.filter((r) => {
    const opening = norm(r.text).slice(0, 40).replace(/\s\S*$/, '');
    return !text.includes(norm(r.author)) || (opening && !text.includes(opening));
  }).map((r) => r.author || '(no author)');
  return { missing, rating: ratingIssue(page.agg, text) };
}

export function reviewNotes(page, result, check) {
  const notes = [];
  const where = page.url.replace('https://www.alanranger.com', '');
  if (result.missing.length) notes.push(check(`${where}: reviews in the schema are not visible on the page: ${result.missing.join(', ')}.`, 'show these reviews on the page or remove them from the schema; tell Claude'));
  if (result.rating) notes.push(check(`${where}: ${result.rating}.`, 'make the rating on the page match the schema; tell Claude'));
  return notes;
}

/** Every reviewed page in the generated landing files, checked against the live page (one request at a time). */
export async function landingReviewNotes(schemaDir, { fetchFn = fetch, ua = 'Mozilla/5.0', gapMs = 1500, check }) {
  if (!fs.existsSync(schemaDir)) return { notes: [], checked: 0 };
  const pages = fs.readdirSync(schemaDir).filter((f) => f.endsWith('.json'))
    .flatMap((f) => reviewedPages(JSON.parse(fs.readFileSync(path.join(schemaDir, f), 'utf8'))));
  const notes = [];
  for (const [i, page] of pages.entries()) {
    if (i) await new Promise((r) => setTimeout(r, gapMs));
    const res = await fetchFn(page.url, { headers: { 'User-Agent': ua }, signal: AbortSignal.timeout(15000) }).catch(() => null);
    if (!res?.ok) { notes.push(check(`${page.url}: could not read the page to check its reviews (HTTP ${res?.status || 'no answer'}).`, 'resume the run')); continue; }
    notes.push(...reviewNotes(page, checkReviews(page, await res.text()), check));
  }
  return { notes, checked: pages.length };
}
