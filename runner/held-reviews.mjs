/**
 * Held Google reviews made actionable (BAU batch 8). Alan's choice on the BAU Monthly page (bau_review_choices) is
 * applied on the next run as a row of csv processed/15-review-attribution-overrides.csv — the path the lock already
 * trusts — and the reviewer's name is added to the alias list. The page only ever gets an opaque key, the first name,
 * the date, the stars and the review text.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';

const norm = (s) => String(s || '').trim().toLowerCase();
const day = (d) => String(d || '').slice(0, 10);
export const reviewKey = (reviewer, date) => crypto.createHash('sha256').update(`google|${norm(reviewer)}|${day(date)}`).digest('hex').slice(0, 20);
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '(no name)';
const STARS = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
const stars = (r) => STARS[String(r || '').toUpperCase()] || Number(r) || null;

const OVERRIDE_COLS = ['source', 'reviewer_name', 'review_date', 'reference_id', 'product_slug', 'scope', 'priority', 'notes'];
const ALIAS_COLS = ['reviewer_name', 'product_slug', 'decided_at', 'source'];
const cell = (v) => (/[",\r\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));

/** Appends CSV rows keeping the file's BOM / CRLF; creates the file (BOM + CRLF) with a header if missing. */
function appendCsv(file, cols, rows) {
  if (!rows.length) return;
  const exists = fs.existsSync(file);
  const text = exists ? fs.readFileSync(file, 'utf8') : '';
  const eol = !exists || text.includes('\r\n') ? '\r\n' : '\n';
  const head = exists ? (text.endsWith('\n') ? '' : eol) : `\uFEFF${cols.join(',')}${eol}`;
  fs.writeFileSync(file, text + head + rows.map((r) => cols.map((c) => cell(r[c])).join(',') + eol).join(''), 'utf8');
}

function overrideRow(review, choice, today) {
  const note = choice.choice === 'exclude' ? `bau_needs_alan_${today}_exclude_${choice.reason}` : `bau_needs_alan_${today}`;
  return { source: 'Google', reviewer_name: review.reviewer, review_date: day(review.date), reference_id: '',
    product_slug: choice.choice === 'product' ? choice.product_slug : '', scope: choice.choice, priority: '100', notes: note };
}

/**
 * Choices whose review is in this run's Google fetch become override rows (+ alias rows for product choices).
 * Rows already in the overrides file (same reviewer + date) are not added twice. Returns what was applied.
 */
export function applyChoices({ choices, googleRows, overridesFile, aliasFile, today = new Date().toISOString().slice(0, 10) }) {
  const byKey = new Map(choices.map((c) => [c.review_key, c]));
  const existing = fs.existsSync(overridesFile) ? fs.readFileSync(overridesFile, 'utf8').toLowerCase() : '';
  const applied = [];
  const overrides = [];
  const aliases = [];
  for (const r of googleRows) {
    const choice = byKey.get(reviewKey(r.reviewer, r.date));
    if (!choice) continue;
    applied.push({ review_key: choice.review_key, choice: choice.choice, product_slug: choice.product_slug || null });
    if (existing.includes(`google,${norm(r.reviewer)},${day(r.date)}`)) continue;
    overrides.push(overrideRow(r, choice, today));
    if (choice.choice === 'product') aliases.push({ reviewer_name: r.reviewer, product_slug: choice.product_slug, decided_at: today, source: 'bau_review_choice' });
  }
  appendCsv(overridesFile, OVERRIDE_COLS, overrides);
  appendCsv(aliasFile, ALIAS_COLS, aliases);
  return { applied, overrides_added: overrides.length, aliases_added: aliases.length };
}

/** Plain-English reason the matcher held it (or what it would pick), from its report line. */
function whyHeld(result) {
  if (!result) return 'No matching evidence yet (new review).';
  const why = String(result.orders_why || result.why || '').replace(/^hold:\s*/, '');
  return why ? `${why.charAt(0).toUpperCase()}${why.slice(1)}.` : 'No booking, order, place or service words point to one product.';
}

/** One Needs Alan card per held review: first name, date, stars, text, why held, suggestion + up to 3 alternatives. */
export function heldItems(pendingRows, matcherResults) {
  const results = new Map(matcherResults.map((m) => [`${norm(m.reviewer)}|${day(m.date)}`, m]));
  return pendingRows.map((p) => {
    const m = results.get(`${norm(p.reviewer)}|${day(p.date)}`);
    const suggested = p.suggested_product_slug || m?.orders_slug || m?.shadow_slug || '';
    return { kind: 'held_review', count: 1, key: reviewKey(p.reviewer, p.date), first_name: firstName(p.reviewer), date: day(p.date), rating: stars(p.rating),
      text: String(p.review || ''), why: whyHeld(m), suggested, alternatives: (Array.isArray(m?.candidates) ? m.candidates : []).filter((s) => s !== suggested).slice(0, 3),
      file: 'held Google review: choose a product, business level or exclude' };
  });
}

/** Test aid (dry only): simulated held reviews, keys prefixed so the clean-up can remove only them. */
export function simulatedHeld(n, products) {
  const texts = ['A lovely morning in the woods, learned so much about composition.', 'Great evening class, finally off auto mode.',
    'Alan was patient and the location was stunning.', 'Not what I expected, the session was cut short.'];
  return Array.from({ length: n }, (_, i) => ({ kind: 'held_review', count: 1, key: `bau-test-held-${i + 1}`, first_name: `Testreviewer${i + 1}`,
    date: '2026-11-01', rating: [5, 5, 4, 2][i % 4], text: texts[i % 4], why: 'Simulated held review (test only).',
    suggested: products[i % products.length]?.slug || '', alternatives: products.slice(1, 4).map((p) => p.slug), file: 'simulated held review (test)', simulated: true }));
}
