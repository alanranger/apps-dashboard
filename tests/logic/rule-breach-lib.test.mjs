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
      { id: 'c', summary: 'Football', transparency: 'transparent', start: { dateTime: `${day}T15:00:00+01:00` }, end: { dateTime: `${day}T17:00:00+01:00` } },
    ];
    const { mc, busy } = splitMcAndBusy(events, rules);
    assert.equal(mc.length, 1);
    assert.equal(busy.length, 1);
    assert.equal(busy[0].summary, 'Josh Birthday');
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
