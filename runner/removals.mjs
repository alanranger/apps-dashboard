/**
 * Removal check for a stage's publish set (Claude, 3 Nov, condition 2): anything a published file loses —
 * offers / price / priceSpecification, aggregateRating, reviews, or an @type — on ANY node. A removal counts as
 * explained only when a known rule covers it; any unexplained removal blocks Live for that stage.
 */
const KEY_PROPS = ['offers', 'price', 'priceSpecification', 'aggregateRating', 'review'];
const BUSINESS = /^(LocalBusiness|Organization|ProfessionalService)$/;
/** Types that only exist inside a counted property (their loss is reported through that property). */
const NESTED_ONLY = new Set(['Review', 'Rating', 'AggregateRating', 'ListItem']);

const asArr = (v) => (v == null ? [] : [].concat(v));
const typesOf = (n) => asArr(n?.['@type']).map(String);
const topNodes = (doc) => (Array.isArray(doc?.['@graph']) ? doc['@graph'] : doc && typeof doc === 'object' ? [doc] : []);

function walk(o, fn) {
  if (Array.isArray(o)) { o.forEach((x) => walk(x, fn)); return; }
  if (!o || typeof o !== 'object') return;
  fn(o);
  Object.values(o).forEach((v) => walk(v, fn));
}

function typeCounts(doc) {
  const m = new Map();
  walk(doc, (o) => typesOf(o).forEach((t) => m.set(t, (m.get(t) || 0) + 1)));
  return m;
}

/** How much of a property a node carries: review = number of reviews; others = number of occurrences. */
function propCount(node, prop) {
  let n = 0;
  walk(node, (o) => { if (o[prop] != null) n += prop === 'review' ? asArr(o[prop]).length : 1; });
  return n;
}

const nodeKey = (n, i) => n['@id'] || `${typesOf(n).join('+') || 'node'}#${i}`;

function nodeRemovals(nb, na, key) {
  const out = [];
  const types = typesOf(nb);
  for (const prop of KEY_PROPS) {
    const b = propCount(nb, prop);
    const a = propCount(na, prop);
    if (a < b) out.push({ node: key, nodeTypes: types, prop, from: b, to: a, what: prop === 'review' ? `reviews ${b} → ${a}` : a ? `${prop} ${b} → ${a}` : `${prop} removed` });
  }
  for (const t of types.filter((x) => !typesOf(na).includes(x))) out.push({ node: key, nodeTypes: types, type: t, what: `@type ${t} dropped from the node` });
  return out;
}

function removedNode(nb, key) {
  const start = Date.parse(nb.startDate || '');
  return { node: key, nodeTypes: typesOf(nb), what: 'node removed', pastEvent: Number.isFinite(start) && start < Date.now() };
}

/** Every removal from `before` to `after` (one published file). */
export function findRemovals(before, after) {
  if (!before) return [];
  const out = [];
  const afterNodes = new Map(topNodes(after).map((n, i) => [nodeKey(n, i), n]));
  topNodes(before).forEach((nb, i) => {
    const key = nodeKey(nb, i);
    const na = afterNodes.get(key);
    // A node that only changed @id (rebuilt breadcrumb, image, video) is not a loss: a gone node counts when it
    // carried offers / price / ratings; types that vanish entirely are caught file-wide below.
    if (!na && KEY_PROPS.some((p) => propCount(nb, p) > 0)) out.push(removedNode(nb, key));
    else if (na) out.push(...nodeRemovals(nb, na, key));
  });
  const tb = typeCounts(before);
  const ta = typeCounts(after);
  for (const [t] of tb) if (!ta.has(t) && !NESTED_ONLY.has(t)) out.push({ node: '(file)', type: t, what: `@type ${t} no longer anywhere in the file` });
  return out;
}

const isBusiness = (r) => (r.nodeTypes || []).some((t) => BUSINESS.test(t));
const isItemList = (r) => r.type === 'ItemList' || (r.nodeTypes || []).includes('ItemList');

/** Types that exist only inside an Offer (their loss follows the offers being rebuilt). */
const OFFER_TYPES = new Set(['Offer', 'AggregateOffer', 'OfferShippingDetails', 'DefinedRegion', 'MerchantReturnPolicy', 'MonetaryAmount', 'UnitPriceSpecification', 'PriceSpecification']);
const sellingSource = (c, field) => (String(c.sellingNote || '').match(new RegExp(`${field} = ([^|]+)`)) || [])[1]?.trim() || null;
const live = (src) => src && !/missing|carried forward/.test(src);

/** Known rules: [stage, test(removal, ctx), explanation]. Anything else is unexplained. */
const RULES = [
  // Claude/Alan 3 Nov (10): a selling landing page's offers and ratings are rebuilt from live sources each run.
  ['G', (r, c) => (['offers', 'price', 'priceSpecification'].includes(r.prop) || OFFER_TYPES.has(r.type)) && live(sellingSource(c, 'offers')), 'offers rebuilt from the live source (Squarespace product / page plan)'],
  ['G', (r, c) => ['aggregateRating', 'review'].includes(r.prop) && live(sellingSource(c, 'aggregateRating, review')), 'rating and reviews from the review DB (or none: no genuine reviews of its own)'],
  ['G', (r) => isBusiness(r) && ['aggregateRating', 'review'].includes(r.prop), 'P23: no business rating on landing pages'],
  ['G', (r, c) => isItemList(r) && /ItemList removed/.test(c.landingNote || ''), 'page shows no list of pages (landing explainer)'],
  ['DE', reviewsMatch04, 'review re-homing (31 Oct / 2 Nov): same review set as the published product schema (04)'],
  ['E', (r) => r.what === 'node removed' && r.pastEvent, 'past-dated event dropped']
];

/** Shared D/E rule (Claude 3 Nov, 9.1): fewer reviews, and the new count equals the product's published 04 review set. */
function reviewsMatch04(r, c) {
  if (r.prop !== 'review' || typeof c.reviews04 !== 'function') return false;
  const want = c.reviews04(r.node);
  return want != null && Number(want) === r.to;
}

/** The rule that explains a removal, or null. ctx: { stage, landingNote, reviews04(nodeId) } for this file. */
export function explainRemoval(r, ctx = {}) {
  return RULES.find(([stages, test]) => stages.includes(ctx.stage) && test(r, ctx))?.[2] || null;
}

/** Removals for a publish set: [{ file, what, node, explained_by }] + counts. */
export function checkPublishSet(files, { readBefore, readAfter, contextFor }) {
  const rows = [];
  for (const file of files) {
    const ctx = contextFor(file);
    for (const r of findRemovals(readBefore(file), readAfter(file))) rows.push({ file, node: r.node, what: r.what, explained_by: explainRemoval(r, ctx) });
  }
  const unexplained = rows.filter((r) => !r.explained_by);
  return { rows, unexplained, files_with_unexplained: [...new Set(unexplained.map((r) => r.file))] };
}
