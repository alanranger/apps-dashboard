import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isException, buildExceptions } from '../../mc/exceptions.js';

describe('exceptions — Needs your decision filter', () => {
  it('flags overlaps, caps, unnamed gaps, and UNPLACEABLE habits', () => {
    assert.equal(isException({
      proposed_action: 'Move one of the overlapping blocks so they do not share time',
      reason: 'mc_vs_mc_overlap=30m',
      summary: 'Rule breach: A overlaps B by 30m',
    }), true);
    assert.equal(isException({
      related_id: 'breach:cap:2026-08-07',
      proposed_action: 'Spread blocks across following legal days — over the 270m hard limit',
      summary: 'Rule breach: 330m MC work on 2026-08-07 exceeds 240m cap +30m tolerance',
    }), true);
    assert.equal(isException({
      reason: 'decompress_after_task_min=30',
      proposed_action: 'Add 75m gap or move MC-? later',
      summary: 'Rule breach: MC-? → MC-? gap -45m < 30m decompress',
    }), true);
    assert.equal(isException({
      change_type: 'missed_habit',
      proposed_action: 'UNPLACEABLE (backward): "Send Out Joining Details" … decide manually',
      summary: 'Missed habit: Send Out Joining Details',
    }), true);
  });

  it('excludes concrete-slot proposals (fixture, travel, forward roll, residential move)', () => {
    assert.equal(isException({
      change_type: 'fixture_block',
      proposed_action: 'Create informational MC ⚽ block 2026-08-22 14:00–18:00 for "…"',
      summary: 'Fixture: Ipswich — 2026-08-22',
    }), false);
    assert.equal(isException({
      change_type: 'missed_habit',
      proposed_action: 'Roll forward to next working day 2026-07-27 at 10:00 (roll 1/3). Title: MC 🔁 Blog',
      summary: 'Missed habit: Publish Blog Post',
    }), false);
    assert.equal(isException({
      reason: 'residential_or_all_day:x',
      proposed_action: 'Move MC-11 off 2026-09-01 — busy map excludes MC blocks',
      summary: 'Rule breach: MC-11 lands on busy/residential day',
    }), false);
  });

  it('enriches an overlap with both titles and move options', () => {
    const [ex] = buildExceptions([{
      id: '1',
      target_date: '2026-08-07',
      urgency: 'high',
      reason: 'mc_vs_mc_overlap=30m',
      proposed_action: 'Move one of the overlapping blocks so they do not share time',
      summary: 'Rule breach: P3 · MC-2 · Walkthrough overlaps P3 · MC-13 · Sign-off by 30m',
    }]);
    assert.equal(ex.typeLabel, 'Overlap');
    assert.match(ex.clashing, /Walkthrough/);
    assert.match(ex.clashing, /Sign-off/);
    assert.match(ex.options, /Move/);
  });
});
