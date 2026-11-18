import test from 'node:test';
import assert from 'node:assert/strict';
import { addedUrls, sitemapDecision } from '../../runner/sitemap-nudge.mjs';

const now = '2026-11-18T10:00:00.000Z';
const hourAgo = { submitted_at: '2026-11-18T09:00:00.000Z', new_urls: ['https://www.alanranger.com/a', 'https://www.alanranger.com/b'] };

test('two new URLs submit; none skips; a repeat inside 24 hours with no further URLs does not submit again', () => {
  const first = sitemapDecision({ added: ['https://www.alanranger.com/a', 'https://www.alanranger.com/b'], last: null, now });
  assert.equal(first.submit, true);
  assert.match(first.text, /2 new URLs/);
  const none = sitemapDecision({ added: [], last: null, now });
  assert.equal(none.submit, false);
  assert.equal(none.text, 'skipped: no new pages');
  const again = sitemapDecision({ added: first.urls, last: { ...hourAgo, new_urls: first.urls }, now });
  assert.equal(again.submit, false);
});

test('a new URL since the last submit still submits inside 24 hours', () => {
  const next = sitemapDecision({
    added: ['https://www.alanranger.com/a', 'https://www.alanranger.com/c'],
    last: hourAgo,
    now
  });
  assert.deepEqual(next.urls, ['https://www.alanranger.com/c']);
  assert.equal(next.submit, true);
});

test('only URLs that were not in the previous file count as new', () => {
  const before = 'url\nhttps://www.alanranger.com/old\n';
  const after = 'url\nhttps://www.alanranger.com/old\nhttps://www.alanranger.com/new\n';
  assert.deepEqual(addedUrls(before, after, 'url'), ['https://www.alanranger.com/new']);
});
