/**
 * After a live publish, tell Google about new public URLs by resubmitting the sitemap.
 * A failure is a warning. No new URLs means skip. The same URLs are not submitted twice inside 24 hours.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

export const SITEMAP = 'https://www.alanranger.com/sitemap.xml';
export const SITE = 'https://www.alanranger.com/';
export const WRITE_SCOPE = 'https://www.googleapis.com/auth/webmasters';

export const URL_FILES = [
  ['csv/01-blog-posts.csv', 'Full Url'],
  ['csv/02-beginners-photography-lessons.csv', 'Event_URL'],
  ['csv/03-photographic-workshops-near-me.csv', 'Event_URL'],
  ['csv/04-photography-services-courses-mentoring.csv', 'Full Url'],
  ['csv/05-photo-workshops-uk-landscape.csv', 'Full Url'],
  ['csv/06-site-urls.csv', 'url'],
  ['csv/08-landing-and-service-pages.csv', 'url']
];

export function columnUrls(csv, column) {
  const lines = String(csv || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const heads = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
  const i = heads.indexOf(column);
  if (i < 0) return [];
  return lines.slice(1).map((line) => (line.split(',')[i] || '').trim()).filter((u) => /^https?:\/\//i.test(u));
}

export function addedUrls(beforeText, afterText, column) {
  const before = new Set(columnUrls(beforeText, column));
  return columnUrls(afterText, column).filter((u) => !before.has(u));
}

export function addedFromPair(beforeByFile, afterByFile) {
  const out = [];
  for (const [file, column] of URL_FILES) {
    out.push(...addedUrls(beforeByFile[file] || '', afterByFile[file] || '', column));
  }
  return [...new Set(out)];
}

export function sitemapDecision({ added, last, now }) {
  const fresh = [...new Set(added || [])].filter(Boolean);
  const sent = new Set(last?.new_urls || []);
  const urls = fresh.filter((u) => !sent.has(u));
  if (!urls.length) {
    return { submit: false, status: 'skipped', text: 'skipped: no new pages', urls: [] };
  }
  return {
    submit: true,
    status: 'ok',
    text: `Tell Google about new pages (sitemap resubmitted, ${urls.length} new URLs)`,
    urls
  };
}

function gitShow(repo, spec) {
  try {
    return execFileSync('git', ['show', spec], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

export function addedInCommits(repo, commits) {
  const added = [];
  for (const sha of commits || []) {
    if (!sha) continue;
    const before = {};
    const after = {};
    for (const [file] of URL_FILES) {
      before[file] = gitShow(repo, `${sha}^:${file}`);
      after[file] = gitShow(repo, `${sha}:${file}`);
    }
    if (!Object.values(after).some(Boolean)) continue;
    added.push(...addedFromPair(before, after));
  }
  return [...new Set(added)];
}

function envFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i < 1 || line.startsWith('#')) continue;
    out[line.slice(0, i)] = line.slice(i + 1).replace(/^"|"$/g, '').trim();
  }
  return out;
}

export function loadGoogleEnv() {
  const home = 'G:/Dropbox/alan ranger photography/Website Code/AI GEO Audit/.env.vercel.prod';
  return envFile(home);
}

export async function submitSitemap(accessToken) {
  const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(SITE)}/sitemaps/${encodeURIComponent(SITEMAP)}`;
  const res = await fetch(url, { method: 'PUT', headers: { Authorization: `Bearer ${accessToken}` } });
  const body = (await res.text()).slice(0, 400);
  return { ok: res.ok, status: res.status, body };
}

export function scopeAllowsSubmit(scope) {
  return String(scope || '').split(/\s+/).includes(WRITE_SCOPE);
}
