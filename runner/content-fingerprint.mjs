/**
 * Main-content fingerprint for a Squarespace page (Alan 3 Nov, option 5: B re-reads only pages whose main content
 * changed). The raw HTML changes on every fetch (crumb tokens, cache-busters, rotating image format= params,
 * scripts), so its hash can't tell an edit from noise. This hashes only what a reader sees in the page's main region:
 *   - the <main> element (fallback: <body>), minus scripts / styles / forms / svg and the blog furniture that changes
 *     when OTHER posts change (previous / next links, share, comments, newsletter, summary lists);
 *   - its visible text (entities decoded, whitespace collapsed);
 *   - its image paths (query strings such as ?format=750w dropped);
 *   - the page's hosted schema references (schema.alanranger.com/*.json).
 */
import crypto from 'node:crypto';

const DROP_TAGS = ['script', 'style', 'noscript', 'svg', 'template', 'form', 'iframe', 'button'];
/** class fragments of blocks inside <main> that change when other pages change, not this page's own content. */
const DROP_CLASSES = ['BlogItem-pagination', 'BlogItem-comments', 'BlogItem-share', 'newsletter-form', 'sqs-block-newsletter',
  'summary-v2-block', 'sqs-block-summary-v2', 'squarespace-comments', 'sqs-block-tourdates', 'sqs-block-instagram',
  // product pages: "You Might Also Like" rotates on every load; previous / next product links; share buttons
  'ProductItem-related', 'pagination', 'Share-buttons',
  // event pages: "Earlier / Later Event" links change when other events are added or end
  'eventitem-pager'];

/** The first <tag ...> ... </tag> region, matched by depth. */
function region(html, tag) {
  const open = new RegExp(`<${tag}\\b[^>]*>`, 'i').exec(html);
  if (!open) return null;
  const end = matchingClose(html, tag, open.index + open[0].length);
  return end > 0 ? html.slice(open.index, end) : html.slice(open.index);
}

/** Index just after the </tag> that closes the element opened before `from`, or -1. */
function matchingClose(html, tag, from) {
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
  re.lastIndex = from;
  let depth = 1;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m[0].endsWith('/>')) continue;
    depth += m[1] ? -1 : 1;
    if (depth === 0) return m.index + m[0].length;
  }
  return -1;
}

/** Remove every element whose class attribute contains one of `fragments` (with everything inside it). */
function dropByClass(html, fragments) {
  const re = new RegExp(`<([a-z0-9]+)\\b[^>]*\\bclass="[^"]*(?:${fragments.map((f) => f.replace(/[-]/g, '\\-')).join('|')})[^"]*"[^>]*>`, 'i');
  let out = html;
  for (let m = re.exec(out), guard = 0; m && guard < 500; m = re.exec(out), guard += 1) {
    const end = matchingClose(out, m[1], m.index + m[0].length);
    out = out.slice(0, m.index) + (end > 0 ? out.slice(end) : out.slice(m.index + m[0].length));
  }
  return out;
}

const decode = (s) => s.replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;|&#x27;|&rsquo;|&lsquo;/g, "'").replace(/&ldquo;|&rdquo;/g, '"')
  .replace(/&ndash;/g, '–').replace(/&mdash;/g, '—').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));

/** Image file paths in the region: src / data-src / data-image, query dropped, de-duplicated, in order. */
function imagePaths(html) {
  const found = [...html.matchAll(/\b(?:src|data-src|data-image)="(https?:\/\/[^"]+|\/\/[^"]+)"/gi)].map((m) => m[1].replace(/^\/\//, 'https://').split('?')[0]);
  return [...new Set(found.filter((u) => /\.(jpe?g|png|gif|webp|avif)$/i.test(u) || /squarespace-cdn\.com|static1\.squarespace\.com/i.test(u)))];
}

/** The parts that make up the fingerprint (exported for tests and the "why changed" report). */
export function contentParts(html) {
  const raw = String(html || '');
  let main = region(raw, 'main') || region(raw, 'body') || raw;
  main = main.replace(/<!--[\s\S]*?-->/g, '');
  for (const t of DROP_TAGS) main = main.replace(new RegExp(`<${t}\\b[\\s\\S]*?<\\/${t}>`, 'gi'), ' ');
  main = dropByClass(main, DROP_CLASSES);
  const text = decode(main.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  const schema = [...new Set(raw.match(/https:\/\/schema\.alanranger\.com\/[^"' )<>]+\.json/g) || [])].sort();
  return { text, images: imagePaths(main), schema, hasMain: /<main\b/i.test(raw) };
}

export function contentFingerprint(html) {
  const p = contentParts(html);
  return crypto.createHash('sha256').update(`${p.text}\n--img--\n${p.images.join('\n')}\n--schema--\n${p.schema.join('\n')}`).digest('hex');
}
