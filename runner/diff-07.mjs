/**
 * 07 (chat-ingest product schema CSV) difference list: per product, the new 07 against the live 07. Every changed
 * field is listed and explained against its source (Squarespace now = raw-01; reviews = the merged review file);
 * a change that no source explains is marked unexplained.
 */
const ldJson = (cell) => {
  const m = String(cell || '').match(/<script[^>]*>([\s\S]*?)<\/script>/i);
  try { return JSON.parse(m ? m[1] : cell); } catch { return null; }
};
const slugOf = (url) => String(url || '').replace(/\/$/, '').split('/').pop();

function byProduct(rows) {
  const map = new Map();
  for (const r of rows) {
    const node = ldJson(r['JSON-LD Structured Data']);
    const key = node?.url || r.Title;
    map.set(key, { title: r.Title, node: node || {}, dup: map.has(key) });
  }
  return map;
}

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
const offerOf = (n) => (Array.isArray(n.offers) ? n.offers[0] : n.offers) || {};
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const show = (v) => (v === undefined || v === null ? '—' : typeof v === 'object' ? JSON.stringify(v).slice(0, 160) : String(v).slice(0, 160));

/** Field → value picker. Top-level keys not listed here are compared one by one as "<key>". */
const FIELDS = {
  title: (p) => p.title,
  'review count': (p) => p.node.aggregateRating?.reviewCount,
  rating: (p) => p.node.aggregateRating?.ratingValue,
  'reviews listed': (p) => (p.node.review || []).length,
  description: (p) => p.node.description
};
const COVERED = new Set(['name', 'offers', 'aggregateRating', 'review', 'description']);

/** Squarespace now (raw-01, one row per variant), keyed by product slug. */
export function squarespaceIndex(raw01Rows) {
  const idx = new Map();
  for (const r of raw01Rows) {
    const slug = slugOf(r['Product URL']);
    const e = idx.get(slug) || { titles: new Set(), skus: new Set(), prices: new Set(), options: new Set(), variants: 0, onSale: 0, text: '', images: '' };
    if (r.Title) e.titles.add(r.Title.trim());
    if (r.SKU) { e.skus.add(r.SKU.trim()); e.variants += 1; }
    for (const p of [r.Price, r['Sale Price']]) if (Number(p)) e.prices.add(Number(p).toFixed(2));
    for (let i = 1; i <= 6; i += 1) if (r[`Option Value ${i}`]) e.options.add(norm(r[`Option Value ${i}`]));
    if (/^(yes|true)$/i.test(String(r['On Sale'] || ''))) e.onSale += 1;
    e.text += ` ${String(r.Description || '').replace(/<[^>]+>/g, ' ')}`;
    e.images += ` ${r['Hosted Image URLs'] || ''}`;
    idx.set(slug, e);
  }
  return idx;
}

const words = (s) => norm(s).split(' ').filter((w) => w.length > 3);
const mostlyIn = (text, hay) => { const w = words(text); const h = norm(hay); return w.length > 0 && w.filter((x) => h.includes(x)).length / w.length >= 0.8; };

const SKU_WHY = 'a current Squarespace variant SKU (first variant in the export)';
const sku = (c, sq) => (sq?.skus.has(c.newRaw) ? SKU_WHY : null);
/** Review totals: the published product schema (04) is the reference the 07 must match. */
const reviews = (c, sq, ref) => {
  if (ref && String(ref[c.what]) === String(c.newRaw)) return `same as the published product schema (04: ${c.newRaw}); the live 07 predates the latest review re-homing`;
  return Number(c.newRaw) > Number(c.liveRaw) ? 'new reviews merged since the live 07' : null;
};

/** Explanation for one changed field, or null when no source explains it. */
const EXPLAIN = {
  title: (c, sq) => (sq?.titles.has(c.newRaw) ? 'Squarespace product title now (renamed since the live 07)' : null),
  price: (c, sq) => (sq?.prices.has(Number(c.newRaw).toFixed(2)) ? 'Squarespace price now' : null),
  sku,
  'offer.sku': sku,
  'offer.name': (c, sq) => {
    if (c.newRaw === undefined && sq?.variants === 1 && !sq.options.size) return 'product has one variant with no option text now (no offer name)';
    return sq?.options.has(norm(c.newRaw)) ? 'first Squarespace variant now (the earlier date has passed or sold)' : null;
  },
  'offer.@id': (c, sq) => (sq?.variants === 1 && String(c.newRaw).endsWith('#offer') ? 'product has one variant now (no #offerN suffix)' : null),
  'offer.priceSpecification': (c, sq) => (c.newRaw === undefined && sq && !sq.onSale ? 'Squarespace sale has ended (no variant on sale now)' : null),
  'offer.validFrom': () => 'generation date (moves every run)',
  'offer.priceValidUntil': () => 'generation date + 1 year (moves every run)',
  'offer.availability': () => 'Squarespace stock now (in stock / sold out)',
  'review count': reviews,
  rating: reviews,
  'reviews listed': () => 'follows the review count change (newest reviews listed)',
  description: (c, sq) => (mostlyIn(c.newRaw, sq?.text) ? 'Squarespace product description now' : null),
  image: (c, sq) => (sq?.images.includes(String(c.newRaw).split('?')[0]) ? 'Squarespace product image now' : null)
};

function rawChanges(live, fresh) {
  const out = Object.entries(FIELDS).map(([what, pick]) => ({ what, liveRaw: pick(live), newRaw: pick(fresh) }));
  const lo = offerOf(live.node); const fo = offerOf(fresh.node);
  out.push({ what: 'price', liveRaw: lo.price, newRaw: fo.price });
  for (const k of new Set([...Object.keys(lo), ...Object.keys(fo)])) if (k !== 'price') out.push({ what: `offer.${k}`, liveRaw: lo[k], newRaw: fo[k] });
  for (const k of new Set([...Object.keys(live.node), ...Object.keys(fresh.node)])) if (!COVERED.has(k)) out.push({ what: k, liveRaw: live.node[k], newRaw: fresh.node[k] });
  return out.filter((c) => !same(c.liveRaw, c.newRaw));
}

/** One product's changes: [{ what, live, new, why }] (why = null when unexplained). */
export function productChanges(live, fresh, sq, ref) {
  return rawChanges(live, fresh).map((c) => ({ what: c.what, live: show(c.liveRaw), new: show(c.newRaw), why: EXPLAIN[c.what]?.(c, sq, ref) || null }));
}

/** 04 (published product schema) review totals by product url, in the 07 field names. */
const reviewRef = (rows04) => new Map(rows04.map((r) => [String(r.url || '').replace(/\/$/, ''), { 'review count': r.review_count, rating: r.average_rating }]));

/**
 * Whole-file difference list. liveRows/newRows: CSV objects with Title + JSON-LD Structured Data;
 * raw01Rows: Squarespace now; rows04: the published product schema (review totals).
 */
export function diff07(liveRows, newRows, raw01Rows = [], rows04 = []) {
  const live = byProduct(liveRows);
  const fresh = byProduct(newRows);
  const sq = squarespaceIndex(raw01Rows);
  const ref = reviewRef(rows04);
  const products = [];
  let unchanged = 0;
  for (const [key, f] of fresh) {
    const l = live.get(key);
    const changes = l ? productChanges(l, f, sq.get(slugOf(key)), ref.get(String(key).replace(/\/$/, ''))) : [];
    if (!l) products.push({ product: f.title, url: key, change: 'added', changes });
    else if (changes.length) products.push({ product: f.title, url: key, change: 'changed', changes });
    else unchanged += 1;
  }
  for (const [key, l] of live) if (!fresh.has(key)) products.push({ product: l.title, url: key, change: 'removed', changes: [] });
  const all = products.flatMap((p) => p.changes);
  const tally = all.reduce((m, c) => ({ ...m, [c.what]: (m[c.what] || 0) + 1 }), {});
  return { live_rows: liveRows.length, new_rows: newRows.length, duplicates: [...fresh.values()].filter((v) => v.dup).length,
    unchanged, changed: products.filter((p) => p.change === 'changed').length, added: products.filter((p) => p.change === 'added').length,
    removed: products.filter((p) => p.change === 'removed').length, unexplained: all.filter((c) => !c.why).length, products, tally };
}
