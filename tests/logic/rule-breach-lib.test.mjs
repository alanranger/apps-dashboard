import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  buildRuleBreachProposals,
  splitMcAndBusy,
} = require('../../api/mc/rule-breach-lib.js');

const rules = {
  daily_task_cap_min: '240',
  daily_task_cap_tolerance_min: '30',
  deadline_reminder_window_exempt: 'true',
  decompress_after_task_min: '30',
  exclude_bank_holidays: 'true',
  working_days: 'mon,tue,wed,thu,fri,sat,sun',
  working_hours_weekday_start: '10:00',
  working_hours_weekday_end: '17:00',
  working_hours_weekend_start: '11:00',
  working_hours_weekend_end: '16:00',
  window_overrun_max_min: '60',
  window_overrun_blocked_by: 'workshop,class,tuition,client_shoot,personal_block',
  title_prefix_deadline: 'MC ⏰',
  title_prefix_travel: 'MC 🚗',
  title_prefix_buffer: 'MC ⏳',
};

const pinned = new Set();
// 2026-08-11 is a Tuesday (not a bank holiday)
const day = '2026-08-11';

function block(id, startHm, endHm, summary, displayId) {
  return {
    id,
    display_id: displayId ?? id,
    summary,
    title: summary,
    colorId: '10',
    start: `${day}T${startHm}:00+01:00`,
    end: `${day}T${endHm}:00+01:00`,
  };
}

describe('rule-breach-lib — cap tolerance + ⏰ exemption', () => {
  it('excludes ⏰ from the task-minute cap when exempt', () => {
    const blocks = [
      block(1, '10:00', '14:00', 'P0 · MC 🔁 Joining Details', 1), // 240m
      block(2, '14:30', '14:50', 'MC ⏰ Hotel Rudyard', 2), // 20m reminder
    ];
    const proposals = buildRuleBreachProposals(blocks, rules, pinned, new Set());
    assert.equal(proposals.filter((p) => p.change_type === 'rule_breach' && p.related_id.includes('cap')).length, 0);
    assert.equal(proposals.filter((p) => p.change_type === 'cap_over_target').length, 0);
  });

  it('reports over-target (not breach) for 241–270', () => {
    const blocks = [
      block(1, '10:00', '14:00', 'P0 · MC 🔁 A', 1), // 240
      block(2, '14:30', '14:45', 'P1 · MC 🔁 B', 2), // 15 → 255
    ];
    const proposals = buildRuleBreachProposals(blocks, rules, pinned, new Set());
    const over = proposals.filter((p) => p.change_type === 'cap_over_target');
    assert.equal(over.length, 1);
    assert.equal(over[0].urgency, 'low');
    assert.equal(proposals.filter((p) => p.related_id.startsWith('breach:cap:')).length, 0);
  });

  it('hard-breaches only above 270', () => {
    const blocks = [
      block(1, '10:00', '14:00', 'P0 · MC 🔁 A', 1), // 240
      block(2, '14:30', '15:15', 'P1 · MC 🔁 B', 2), // 45 → 285
    ];
    const proposals = buildRuleBreachProposals(blocks, rules, pinned, new Set());
    assert.ok(proposals.some((p) => p.related_id === `breach:cap:${day}`));
  });
});

describe('rule-breach-lib — overlap + busy map', () => {
  it('flags MC-vs-MC overlap', () => {
    const blocks = [
      block(1, '10:00', '11:00', 'P3 · MC-2 · Money', 2),
      block(2, '10:30', '11:30', 'P3 · MC-13 · URL', 13),
    ];
    const proposals = buildRuleBreachProposals(blocks, rules, pinned, new Set());
    assert.ok(proposals.some((p) => String(p.reason).includes('mc_vs_mc_overlap')));
  });

  it('never puts MC blocks into the busy map (splitMcAndBusy)', () => {
    const events = [
      { id: 'a', summary: 'P0 · MC 🔁 Blog', colorId: '10', start: { dateTime: `${day}T10:00:00+01:00` }, end: { dateTime: `${day}T12:00:00+01:00` } },
      { id: 'b', summary: 'Josh Birthday', start: { date: '2026-09-01' }, end: { date: '2026-09-02' } },
      { id: 'c', summary: 'Other free', transparency: 'transparent', start: { dateTime: `${day}T15:00:00+01:00` }, end: { dateTime: `${day}T17:00:00+01:00` } },
    ];
    const { mc, busy } = splitMcAndBusy(events, rules);
    assert.equal(mc.length, 1);
    assert.equal(busy.length, 2);
    assert.equal(busy[0].summary, 'Josh Birthday');
    assert.equal(busy[1].summary, 'Other free');
    assert.equal(busy[1].show_as_free, true);
  });

  it('routes Ipswich fixtures to the fixtures bucket, NOT the busy map (informational)', () => {
    const ipswich = 'c_0e7gnac3odl7ki0jfjiaedot9g@group.calendar.google.com';
    const events = [{
      id: 'fix',
      summary: 'Crystal Palace vs Ipswich Town',
      transparency: 'transparent',
      _calendarId: ipswich,
      start: { dateTime: '2026-09-12T15:00:00+01:00' },
      end: { dateTime: '2026-09-12T17:00:00+01:00' },
    }];
    const { busy, fixtures } = splitMcAndBusy(events, { ...rules, fixture_buffer_min: '60' });
    // Placement gets a hard_fixture busy window; diary paint filters hard_fixture out.
    assert.equal(busy.length, 1);
    assert.equal(busy[0].hard_fixture, true);
    assert.equal(fixtures.length, 1);
    assert.equal(fixtures[0].id, 'fix');
  });

  it('never flags an MC ⚽ fixture block against a real commitment (informational)', () => {
    const blocks = [
      block(1, '19:00', '21:00', 'Evening Photography Lesson', 1), // class-like MC block
      {
        id: 'ball', display_id: 900, colorId: '10',
        summary: 'MC ⚽ Ipswich Town vs Coventry City',
        start: `${day}T19:00:00+01:00`,
        end: `${day}T23:00:00+01:00`,
      },
    ];
    const proposals = buildRuleBreachProposals(blocks, { ...rules, title_prefix_fixture: 'MC ⚽' }, pinned, new Set());
    // The ⚽ block must not appear in overlap/residential/cap/window breaches.
    assert.ok(!proposals.some((p) => JSON.stringify(p).includes('⚽')));
    assert.ok(!proposals.some((p) => String(p.reason).includes('mc_vs_mc_overlap')));
  });

  it('does not window-breach travel/buffer blocks', () => {
    const blocks = [{
      id: 't', display_id: 1, colorId: '10',
      summary: 'MC 🚗 Travel out — Kenilworth',
      start: '2026-09-01T17:30:00+01:00',
      end: '2026-09-01T17:50:00+01:00',
    }];
    const proposals = buildRuleBreachProposals(blocks, rules, pinned, new Set());
    assert.equal(proposals.filter((p) => String(p.reason).includes('ends_after')).length, 0);
  });

  it('flags MC task on a residential all-day busy day', () => {
    const blocks = [
      {
        id: 'x', display_id: 11, colorId: '10',
        summary: 'P2 · MC-11 · Money review',
        start: '2026-09-01T10:00:00+01:00',
        end: '2026-09-01T11:00:00+01:00',
      },
    ];
    const busy = [{ id: 'j', summary: 'Josh Birthday', start: { date: '2026-09-01' }, end: { date: '2026-09-02' } }];
    const proposals = buildRuleBreachProposals(blocks, rules, pinned, new Set(), busy);
    assert.ok(proposals.some((p) => String(p.reason).startsWith('residential_or_all_day')));
  });
});

describe('rule-breach-lib — §7a window overrun', () => {
  it('exempts sunrise travel at 05:00 (never a window breach)', () => {
    const blocks = [{
      id: 't', display_id: 1, colorId: '10',
      summary: 'MC 🚗 Travel out — sunrise shoot',
      start: '2026-08-11T05:00:00+01:00',
      end: '2026-08-11T05:30:00+01:00',
    }];
    const proposals = buildRuleBreachProposals(blocks, rules, pinned, new Set());
    assert.equal(proposals.filter((p) => /starts_before|ends_after/.test(p.reason || '')).length, 0);
  });

  it('exempts buffer past window close', () => {
    const blocks = [{
      id: 'b', display_id: 2, colorId: '10',
      summary: 'MC ⏳ Decompress — evening class',
      start: '2026-08-11T21:00:00+01:00',
      end: '2026-08-11T21:30:00+01:00',
    }];
    const proposals = buildRuleBreachProposals(blocks, rules, pinned, new Set());
    assert.equal(proposals.filter((p) => /starts_before|ends_after/.test(p.reason || '')).length, 0);
  });

  it('allows admin overrun ≤60m past close (tolerance, not a breach)', () => {
    const blocks = [{
      id: 'a', display_id: 3, colorId: '10',
      summary: 'P1 · MC 🔁 Publish Blog Post',
      start: '2026-08-11T16:00:00+01:00',
      end: '2026-08-11T17:45:00+01:00', // 45m past 17:00
    }];
    const proposals = buildRuleBreachProposals(blocks, rules, pinned, new Set());
    assert.equal(proposals.filter((p) => String(p.reason).includes('ends_after')).length, 0);
  });

  it('flags genuine admin overrun >60m with no justifying commitment', () => {
    const blocks = [{
      id: 'a', display_id: 4, colorId: '10',
      summary: 'P1 · MC 🔁 Publish Blog Post',
      start: '2026-08-11T16:00:00+01:00',
      end: '2026-08-11T18:15:00+01:00', // 75m past 17:00
    }];
    const proposals = buildRuleBreachProposals(blocks, rules, pinned, new Set());
    assert.ok(proposals.some((p) => String(p.reason).includes('ends_after_17:00')));
    assert.ok(proposals.some((p) => String(p.summary).includes('ends ') && String(p.summary).includes('after')));
  });

  it('exempts admin overrun when day has a class/workshop commitment', () => {
    const blocks = [{
      id: 'a', display_id: 5, colorId: '10',
      summary: 'P1 · MC 🔁 Review notes',
      start: '2026-08-11T18:30:00+01:00',
      end: '2026-08-11T19:30:00+01:00',
    }];
    const busy = [{
      id: 'cls', summary: 'Evening Photography Lesson',
      start: '2026-08-11T19:00:00+01:00',
      end: '2026-08-11T21:00:00+01:00',
    }];
    const proposals = buildRuleBreachProposals(blocks, rules, pinned, new Set(), busy);
    assert.equal(proposals.filter((p) => /starts_before|ends_after/.test(p.reason || '')).length, 0);
  });
});
