import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  firstLegalForward, nearestPriorLegal, computeMissedProposal,
} = require('../../api/mc/missed-habit-lib.js');
const { blockWindow } = require('../../api/mc/fixture-coverage-lib.js');

const rules = {
  working_days: 'mon,tue,wed,thu,fri',
  exclude_bank_holidays: 'true',
  missed_habit_direction: 'backward_if_time_critical',
  title_prefix_recurring: 'MC 🔁',
};
const holidays = new Set(['2026-08-31']); // Summer bank holiday (Mon)

describe('missed-habit-lib — legal-day search', () => {
  it('forward skips weekend to Monday', () => {
    // 2026-07-25 is Sat → next legal is Mon 27
    assert.equal(firstLegalForward('2026-07-25', rules, holidays, 14), '2026-07-27');
  });

  it('backward skips a bank holiday Monday to the Friday before', () => {
    // ideal Tue 2026-09-01, floor before it; prior legal skipping Mon 31 (holiday) = Fri 28
    assert.equal(nearestPriorLegal('2026-09-01', '2026-08-01', rules, holidays), '2026-08-28');
  });

  it('backward returns null when the floor is hit first', () => {
    assert.equal(nearestPriorLegal('2026-07-17', '2026-07-25', rules, holidays), null);
  });
});

describe('missed-habit-lib — directional make-up', () => {
  const base = { today: '2026-07-25', ruleMap: rules, holidays, maxRolls: 3 };

  it('flexible habit rolls forward and costs a roll', () => {
    const prop = computeMissedProposal({
      ...base,
      habit: { title: 'Publish Blog Post', ideal_time: '11:00', rolls_used: 0, time_critical: false },
      lastDue: '2026-07-23',
    });
    assert.equal(prop.rollsDelta, 1);
    assert.ok(prop.proposed.includes('Roll forward'));
  });

  it('time-critical past miss is UNPLACEABLE, never forward-rolled', () => {
    const prop = computeMissedProposal({
      ...base,
      habit: { title: 'Send Out Joining Details', ideal_time: '09:00', rolls_used: 0, time_critical: true },
      lastDue: '2026-07-17',
    });
    assert.equal(prop.rollsDelta, 0);
    assert.ok(prop.proposed.startsWith('UNPLACEABLE'));
    assert.ok(!prop.proposed.includes('Roll forward'));
    assert.equal(prop.urgency, 'high');
  });

  it('time-critical with a legal prior slot rolls BACK', () => {
    // ideal Tue 09-01, today 08-27 → prior legal skipping holiday Mon 31 = Fri 28
    const prop = computeMissedProposal({
      today: '2026-08-27',
      ruleMap: rules,
      holidays,
      maxRolls: 3,
      habit: { title: 'Booking Sheet, Month End Update', ideal_time: '09:00', rolls_used: 0, time_critical: true },
      lastDue: '2026-09-01',
    });
    assert.ok(prop.proposed.includes('Roll BACK to nearest prior legal slot 2026-08-28'));
  });
});

describe('fixture-coverage-lib — block window', () => {
  it('expands kick-off − buffer → end + buffer', () => {
    const win = blockWindow(
      { start: { dateTime: '2026-08-22T15:00:00+01:00' }, end: { dateTime: '2026-08-22T17:00:00+01:00' } },
      60,
    );
    assert.equal(Date.parse(win.block_start), Date.parse('2026-08-22T14:00:00+01:00'));
    assert.equal(Date.parse(win.block_end), Date.parse('2026-08-22T18:00:00+01:00'));
  });
});
