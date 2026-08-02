const test = require('node:test');
const assert = require('node:assert/strict');
const {
  gcalIdFromRowKey,
  isOrphanAgainstParent,
  ORPHAN_DRIFT_DAYS,
} = require('../../api/mc/workshop-travel-reconcile-lib');

test('gcalIdFromRowKey parses gcal prefix', () => {
  assert.equal(gcalIdFromRowKey('gcal:abc123'), 'abc123');
  assert.equal(gcalIdFromRowKey('Surprise View'), null);
});

test('isOrphanAgainstParent when parent missing', () => {
  assert.equal(isOrphanAgainstParent({ starts_at: '2026-08-15T14:00:00Z' }, null), true);
});

test('isOrphanAgainstParent when parent moved beyond drift', () => {
  const row = {
    starts_at: '2026-08-15T14:00:00Z',
    workshop_start: '2026-08-15T18:00:00Z',
  };
  const parent = {
    status: 'confirmed',
    start: { dateTime: '2027-08-14T18:00:00Z' },
  };
  assert.equal(isOrphanAgainstParent(row, parent), true);
  assert.ok(ORPHAN_DRIFT_DAYS >= 7);
});

test('isOrphanAgainstParent when parent still nearby', () => {
  const row = {
    starts_at: '2026-08-15T14:00:00Z',
    workshop_start: '2026-08-15T18:00:00Z',
  };
  const parent = {
    status: 'confirmed',
    start: { dateTime: '2026-08-15T18:30:00Z' },
  };
  assert.equal(isOrphanAgainstParent(row, parent), false);
});
