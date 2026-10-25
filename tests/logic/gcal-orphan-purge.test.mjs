import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  isPurgeableMc, isProtectedMc, listUntiedOrphans,
} = require('../../api/mc/gcal-orphan-purge-lib.js');

test('habits/tasks purgeable; travel protected; unclaimed prep/decompress purgeable', () => {
  assert.equal(isPurgeableMc('MC 🔁 Monthly Accounts — Bank Genie'), true);
  assert.equal(isPurgeableMc('P1 · MC-12 · Something'), true);
  assert.equal(isProtectedMc('MC 🚗 Travel out — Kenilworth'), true);
  assert.equal(isPurgeableMc('MC 🚗 Travel out — Kenilworth'), false);
  assert.equal(isProtectedMc('MC ⏳ Decompress — Camera Courses'), false);
  assert.equal(isPurgeableMc('MC ⏳ Decompress — after X'), true);
  assert.equal(isPurgeableMc('MC ⏳ Prep — Camera Courses Wk2'), true);
});

test('unclaimed MC ⚽ fixture flanks purge; claimed ones are kept', () => {
  assert.equal(isProtectedMc('MC ⚽ Before: Coventry City vs Ipswich Town'), false);
  assert.equal(isPurgeableMc('MC ⚽ After: Coventry City vs Ipswich Town'), true);
  const events = [
    {
      id: 'stale-flank', _calendarId: 'primary', summary: 'MC ⚽ Before: Coventry City vs Ipswich Town',
      start: { dateTime: '2026-12-02T19:00:00Z' },
    },
    {
      id: 'live-flank', _calendarId: 'primary', summary: 'MC ⚽ Before: Coventry City vs Ipswich Town',
      start: { dateTime: '2026-12-01T19:00:00Z' },
    },
  ];
  const orphans = listUntiedOrphans(events, new Set(['live-flank']));
  assert.deepEqual(orphans.map((o) => o.id), ['stale-flank']);
});

test('listUntiedOrphans skips claimed and protected', () => {
  const claimed = new Set(['keep-me']);
  const events = [
    {
      id: 'orphan-1', _calendarId: 'primary', summary: 'MC 🔁 Hotel bookings',
      start: { dateTime: '2026-08-26T12:00:00Z' },
    },
    {
      id: 'keep-me', _calendarId: 'primary', summary: 'MC 🔁 Hotel bookings',
      start: { dateTime: '2026-08-30T12:00:00Z' },
    },
    {
      id: 'travel', _calendarId: 'primary', summary: 'MC 🚗 Travel out — X',
      start: { dateTime: '2026-08-26T08:00:00Z' },
    },
  ];
  const orphans = listUntiedOrphans(events, claimed);
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].id, 'orphan-1');
});
