import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { restDayGcalTitle, awaySpanGcalTitle } = require('../../api/mc/gcal-title-lib.js');
const { allDayEventBody } = require('../../api/mc/gcal-write-lib.js');

test('rest and away titles', () => {
  assert.equal(restDayGcalTitle('Hartland Quay'), 'MC 🛌 REST — after Hartland Quay');
  assert.equal(awaySpanGcalTitle({ venue_name: 'Rosedale Abbey' }), 'MC 🚫 AWAY — Rosedale Abbey');
});

test('all-day body uses exclusive end date', () => {
  const body = allDayEventBody({
    summary: 'MC 🛌 REST — after X',
    startDate: '2026-09-07',
    endDateExclusive: '2026-09-08',
  });
  assert.deepEqual(body.start, { date: '2026-09-07' });
  assert.deepEqual(body.end, { date: '2026-09-08' });
  assert.equal(body.colorId, '10');
});
