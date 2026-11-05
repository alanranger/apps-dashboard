import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reviewedPages, checkReviews, reviewNotes, landingReviewNotes } from '../../runner/landing-reviews.mjs';

const FIX = path.join('tests', 'fixtures', 'landing-reviews');
const schema = JSON.parse(fs.readFileSync(path.join(FIX, 'free-online-photography-course_landing_schema.json'), 'utf8'));
const html = fs.readFileSync(path.join(FIX, 'free-online-photography-course.html'), 'utf8');
const check = (text, todo) => ({ level: 'check', text, todo });

test('free-online-photography-course: all 4 schema reviews are visible and "5.0 out of 5 from 4 reviews" matches', () => {
  const [page] = reviewedPages(schema);
  assert.equal(page.url, 'https://www.alanranger.com/free-online-photography-course');
  assert.equal(page.reviews.length, 4);
  const r = checkReviews(page, html);
  assert.deepEqual(r, { missing: [], rating: null });
  assert.deepEqual(reviewNotes(page, r, check), []);
});

test('a schema review that is not on the page gives a plain WARN naming the page and the review', () => {
  const [page] = reviewedPages(schema);
  const forced = { ...page, reviews: [...page.reviews, { author: 'Not A Reviewer', text: 'This review was never shown on the page at all.' }] };
  const notes = reviewNotes(forced, checkReviews(forced, html), check);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].level, 'check');
  assert.equal(notes[0].text, '/free-online-photography-course: reviews in the schema are not visible on the page: Not A Reviewer.');
});

test('a rating that differs from the page gives a plain WARN', () => {
  const [page] = reviewedPages(schema);
  const off = { ...page, agg: { ...page.agg, reviewCount: 9 } };
  const notes = reviewNotes(off, checkReviews(off, html), check);
  assert.equal(notes[0].text, "/free-online-photography-course: the schema rating (5 from 9 reviews) doesn't match the page (5 from 4 reviews).");
});

test('landingReviewNotes reads every generated landing file and only warns (never a problem)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bau-landing-'));
  fs.writeFileSync(path.join(dir, 'free-online-photography-course_landing_schema.json'), JSON.stringify(schema));
  fs.writeFileSync(path.join(dir, 'no-reviews_landing_schema.json'), JSON.stringify({ '@graph': [{ '@type': 'WebPage', url: 'https://www.alanranger.com/x' }] }));
  const fetchFn = async () => ({ ok: true, status: 200, text: async () => html });
  const r = await landingReviewNotes(dir, { fetchFn, gapMs: 0, check });
  assert.deepEqual(r, { notes: [], checked: 1 });
});
