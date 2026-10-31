/**
 * Coverage check (BAU Monthly summary): every file in the schema repo mapped to the step that produces it.
 * Exempt: loaders/ (hand-maintained), Assignments/, and repo meta files. A file with no producer is an orphan.
 */
import fs from 'node:fs';
import path from 'node:path';

const EXEMPT_DIRS = ['loaders', 'Assignments', '.github', '.git'];
const EXEMPT_FILES = new Set(['.gitignore', 'CNAME', 'README.md', '.nojekyll']);
const HUB_FAQS = new Set(['beginners-photography-lessons_faq.json', 'photographic-workshops-near-me_faq.json']);
const BLOG_SUFFIXES = ['_schema.json', '_blogposting.json', '_breadcrumb.json', '_image.json', '_howto.json', '_faq.json'];

export const TABS = { product_schema: 'Product', event_index: 'Event Index', event_posts: 'Event Posts (+hub FAQs)',
  blog_index: 'Blog Index', blog_posts: 'Blog Posts', landing_pages: 'Landing/Service' };

/** Ordered rules: first match names the producing step. */
function rules(productFiles, blogSlugs) {
  const blogSlug = (f) => { const s = BLOG_SUFFIXES.find((x) => f.endsWith(x)); return s ? f.slice(0, -s.length) : null; };
  return [
    ['event_posts', (f) => /_event_(schema|faq)\.json$/.test(f) || f === 'events-manifest.json' || HUB_FAQS.has(f)],
    ['event_index', (f) => f === 'lessons-schema.json' || f === 'workshops-schema.json'],
    ['blog_index', (f) => f === 'blog-schema.json'],
    ['landing_pages', (f) => f.endsWith('_landing_schema.json') || f === 'landings-manifest.json'],
    ['product_schema', (f) => f === 'products-manifest.json' || productFiles.has(f)],
    ['blog_posts', (f) => f === 'blogs-manifest.json' || blogSlugs.has(blogSlug(f))]
  ];
}

function repoFiles(repo, dir = '') {
  return fs.readdirSync(path.join(repo, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) return EXEMPT_DIRS.includes(e.name) && !dir ? [] : repoFiles(repo, rel);
    return EXEMPT_FILES.has(rel) ? [] : [rel];
  });
}

/** productFiles: product *_schema.json names (+ their _faq.json); blogSlugs: blog post url ids. */
export function coverage(repo, productFiles, blogSlugs) {
  const ordered = rules(productFiles, blogSlugs);
  const byStep = Object.fromEntries(Object.keys(TABS).map((k) => [k, 0]));
  const orphans = [];
  for (const f of repoFiles(repo)) {
    const hit = ordered.find(([, test]) => test(f));
    if (hit) byStep[hit[0]] += 1; else orphans.push(f);
  }
  const total = Object.values(byStep).reduce((s, n) => s + n, 0) + orphans.length;
  const uncovered = Object.entries(byStep).filter(([, n]) => !n).map(([k]) => TABS[k]);
  return { total, byStep, orphans, uncoveredTabs: uncovered };
}

export function coverageLine(c) {
  return c.orphans.length ? `Coverage: ${c.total} files, ${c.orphans.length} with no producer: ${c.orphans.join(', ')}`
    : `Coverage: ${c.total} files, all produced by a step`;
}
