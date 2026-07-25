import { createRequire } from 'module';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { occurrencesInRange, lastDueOnOrBefore } = require('../../api/mc/rrule-core.js');
const { buildRuleBreachProposals } = require('../../api/mc/rule-breach-lib.js');

const TEN_HABITS = [
  { title: 'Backup Photos', rrule: 'FREQ=MONTHLY;BYMONTHDAY=5', cadence: '5th day monthly' },
  { title: 'SEO Performance', rrule: 'FREQ=MONTHLY;BYMONTHDAY=4', cadence: '4th day monthly' },
  { title: 'Publish Blog', rrule: 'FREQ=WEEKLY;BYDAY=TH', cadence: 'Every Thursday' },
  { title: 'Joining Details', rrule: 'FREQ=WEEKLY;BYDAY=FR', cadence: 'Every Friday' },
  { title: 'Artfully Walls', rrule: 'FREQ=MONTHLY;BYDAY=2TH', cadence: '2nd Thursday monthly' },
  { title: 'Course Dates', rrule: 'FREQ=WEEKLY;BYDAY=FR', cadence: 'Every Friday' },
  { title: 'Event Schema', rrule: 'FREQ=MONTHLY;INTERVAL=2;BYDAY=4MO', cadence: '4th Monday every other month' },
  { title: 'Monthly Accounts', rrule: 'FREQ=MONTHLY;BYMONTHDAY=3', cadence: '3rd day monthly' },
  { title: 'Booking Sheet', rrule: 'FREQ=MONTHLY;BYMONTHDAY=1', cadence: '1st day monthly' },
  { title: 'Viking GMB', rrule: 'FREQ=MONTHLY;INTERVAL=3;BYDAY=3SA', cadence: '3rd Saturday every 3 months' },
];

describe('RRULE expansion — 10 real habits', () => {
  for (const h of TEN_HABITS) {
    it(`${h.title} expands without error`, () => {
      const occ = occurrencesInRange(h.rrule, '2026-07-01', '2026-10-01');
      assert.ok(Array.isArray(occ));
      assert.ok(occ.length >= 1, `${h.title} should have ≥1 occurrence in 3 months`);
      for (const d of occ) assert.match(d, /^\d{4}-\d{2}-\d{2}$/);
    });
  }

  it('INTERVAL=2 4MO last due before 2026-07-23 is a Monday in May/June 2026', () => {
    const last = lastDueOnOrBefore('FREQ=MONTHLY;INTERVAL=2;BYDAY=4MO', '2026-07-23');
    assert.equal(last, '2026-05-25');
  });
});

describe('rule_breach proposals', () => {
  const ruleMap = {
    working_hours_weekday_start: '10:00',
    working_hours_weekday_end: '17:00',
    working_hours_weekend_start: '11:00',
    working_hours_weekend_end: '16:00',
    working_days: 'mon,tue,wed,thu,fri,sat,sun',
    exclude_bank_holidays: 'true',
    daily_task_cap_min: '240',
    decompress_after_task_min: '30',
  };

  it('detects starts before 10:00 on Tue 11 Aug', () => {
    const blocks = [{
      display_id: 14,
      colorId: '10',
      summary: 'P0 · MC 🔁 Joining Details',
      start: '2026-08-11T09:30:00+01:00',
      end: '2026-08-11T10:15:00+01:00',
    }];
    const proposals = buildRuleBreachProposals(blocks, ruleMap, new Set());
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].change_type, 'rule_breach');
    assert.match(proposals[0].summary, /MC-14 starts 09:30, before 10:00 window/);
    assert.match(proposals[0].proposed_action, /Move to 2026-08-11 10:00/);
    assert.equal(proposals[0].related_id, 'breach:14:2026-08-11');
  });

  it('skips pinned tasks', () => {
    const blocks = [{
      display_id: 14,
      colorId: '10',
      summary: 'P0 · MC 🔁 Joining Details',
      start: '2026-08-11T09:00:00+01:00',
      end: '2026-08-11T09:45:00+01:00',
    }];
    const proposals = buildRuleBreachProposals(blocks, ruleMap, new Set([14]));
    assert.equal(proposals.length, 0);
  });
});

describe('regression — provenance', () => {
  it('scheduleCsv.js does not require DROPBOX env for GitHub path', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync(new URL('../../api/mc/scheduleCsv.js', import.meta.url), 'utf8');
    assert.doesNotMatch(src, /process\.env\.DROPBOX_ACCESS_TOKEN\s*&&/);
  });

  it('habit-projection reads recurring_tasks not tasks.recurrence', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync(new URL('../../api/mc/habit-projection.js', import.meta.url), 'utf8');
    assert.match(src, /recurring_tasks/);
    assert.doesNotMatch(src, /tasks\.recurrence/);
  });
});
