import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  mondayOnOrBeforeYmd, pickOlderSameWeekSkips,
} = require('../../api/mc/habit-placer-propose-lib.js');

test('mondayOnOrBeforeYmd is Mon–Sun week start', () => {
  assert.equal(mondayOnOrBeforeYmd('2026-08-26'), '2026-08-24');
  assert.equal(mondayOnOrBeforeYmd('2026-08-24'), '2026-08-24');
  assert.equal(mondayOnOrBeforeYmd('2026-08-30'), '2026-08-24');
});

test('pickOlderSameWeekSkips keeps newest ideal in the week', () => {
  const skips = pickOlderSameWeekSkips([
    {
      habit_id: 'blog', ideal_date: '2026-08-13', scheduled_date: '2026-08-26',
    },
    {
      habit_id: 'blog', ideal_date: '2026-08-27', scheduled_date: '2026-08-28',
    },
    {
      habit_id: 'seo', ideal_date: '2026-08-04', scheduled_date: '2026-08-25',
    },
  ]);
  assert.equal(skips.length, 1);
  assert.equal(skips[0].ideal_date, '2026-08-13');
  assert.equal(skips[0].habit_id, 'blog');
});

test('different weeks are not collapsed', () => {
  const skips = pickOlderSameWeekSkips([
    { habit_id: 'blog', ideal_date: '2026-08-13', scheduled_date: '2026-08-20' },
    { habit_id: 'blog', ideal_date: '2026-08-27', scheduled_date: '2026-08-28' },
  ]);
  assert.equal(skips.length, 0);
});
