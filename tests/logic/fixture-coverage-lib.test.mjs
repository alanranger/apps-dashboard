import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  flankWindows, londonHm, matchLabel,
} = require('../../api/mc/fixture-coverage-lib.js');

describe('fixture-coverage-lib — two flanks off real feed time', () => {
  it('Sunderland Sat 15:00 London → Before 14:00–15:00, After 17:00–18:00', () => {
    // Feed may send Z or +01:00; both are the same instant as 15:00 BST.
    const win = flankWindows({
      summary: '⚽️ Ipswich Town vs Sunderland',
      start: { dateTime: '2026-08-22T14:00:00.000Z' },
      end: { dateTime: '2026-08-22T16:00:00.000Z' },
    }, 60);
    assert.ok(win);
    assert.equal(londonHm(win.fixture_start), '15:00');
    assert.equal(londonHm(win.fixture_end), '17:00');
    assert.equal(londonHm(win.before_start), '14:00');
    assert.equal(londonHm(win.before_end), '15:00');
    assert.equal(londonHm(win.after_start), '17:00');
    assert.equal(londonHm(win.after_end), '18:00');
  });

  it('evening kickoff 20:00 London → Before 19:00–20:00, After 22:00–23:00', () => {
    const win = flankWindows({
      summary: '⚽️ Ipswich Town vs Liverpool',
      start: '2026-09-04T19:00:00.000Z', // 20:00 BST
      end: '2026-09-04T21:00:00.000Z',
    }, 60);
    assert.equal(londonHm(win.fixture_start), '20:00');
    assert.equal(londonHm(win.before_start), '19:00');
    assert.equal(londonHm(win.before_end), '20:00');
    assert.equal(londonHm(win.after_start), '22:00');
    assert.equal(londonHm(win.after_end), '23:00');
  });

  it('offset-form feed (+01:00) matches Z form for the same London kickoff', () => {
    const fromZ = flankWindows({
      start: '2026-08-22T14:00:00Z',
      end: '2026-08-22T16:00:00Z',
    }, 60);
    const fromOffset = flankWindows({
      start: '2026-08-22T15:00:00+01:00',
      end: '2026-08-22T17:00:00+01:00',
    }, 60);
    assert.equal(londonHm(fromZ.before_start), londonHm(fromOffset.before_start));
    assert.equal(londonHm(fromZ.after_end), londonHm(fromOffset.after_end));
  });

  it('matchLabel strips ball emoji for titles', () => {
    assert.equal(matchLabel({ summary: '⚽️ Ipswich Town vs Sunderland' }), 'Ipswich Town vs Sunderland');
  });

  it('buffer_min is flank LENGTH not continuous span over the match', () => {
    const win = flankWindows({
      start: '2026-08-22T14:00:00Z',
      end: '2026-08-22T16:00:00Z',
    }, 60);
    // Before ends at kickoff; After starts at match end — gap is the match itself.
    assert.equal(win.before_end, win.fixture_start);
    assert.equal(win.after_start, win.fixture_end);
    assert.notEqual(win.before_end, win.after_start);
  });
});
