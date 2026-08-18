import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  taskGcalTitle, habitGcalTitle, travelGcalTitle, isChangelogTitle,
} = require('../../api/mc/gcal-title-lib.js');
const { planFromPushRow, safeTitle } = require('../../api/mc/gcal-flush-lib.js');
const { timedEventBody } = require('../../api/mc/gcal-write-lib.js');

test('task title uses priority + MC id + DB name', () => {
  assert.equal(
    taskGcalTitle({ display_id: 12, title: 'Page-3 competitor sign-off', priority: 'p3' }),
    'P3 · MC-12 · Page-3 competitor sign-off',
  );
});

test('habit and travel titles use prefixes, not changelog', () => {
  assert.equal(habitGcalTitle('Booking Sheet, Month End Update'), 'MC 🔁 Booking Sheet, Month End Update');
  assert.equal(
    travelGcalTitle({ block_type: 'travel_back', workshop_title: 'Rosedale' }),
    'MC 🚗 Travel back — Rosedale → home',
  );
  assert.equal(
    travelGcalTitle({ block_type: 'prep', workshop_title: 'Composition Class' }),
    'MC ⏳ Prep — Composition Class',
  );
});

test('changelog strings are rejected as titles', () => {
  assert.equal(isChangelogTitle('MC 🚗 Move travel_out Burnham to follow workshop 19:00'), true);
  assert.equal(isChangelogTitle('Scheduler bump MC-2 → 2026-08-08'), true);
  assert.equal(isChangelogTitle('MC 🔁 Booking Sheet, Month End Update'), false);
  assert.equal(safeTitle('Move travel_out X', null), null);
});

test('flush plan refuses move when only changelog title available', () => {
  const plan = planFromPushRow({
    id: 'x',
    entity_type: 'travel',
    change_kind: 'move',
    summary: 'Move travel_out Burnham to follow workshop',
    payload: {
      calendar_event_id: 'abc',
      new_start: '2026-08-03T18:00:00.000Z',
      new_end: '2026-08-03T20:00:00.000Z',
    },
  }, {}, null);
  assert.equal(plan.skip, true);
  assert.equal(plan.reason, 'move_missing_db_title');
});

test('writer body sets colorId 10, no reminders, habits/tasks Free', () => {
  const habit = timedEventBody({
    summary: 'MC 🔁 Test',
    startIso: '2026-08-01T09:00:00.000Z',
    endIso: '2026-08-01T10:00:00.000Z',
  });
  assert.equal(habit.colorId, '10');
  assert.equal(habit.transparency, 'transparent');
  assert.deepEqual(habit.reminders, { useDefault: false, overrides: [] });

  const task = timedEventBody({
    summary: 'P2 · MC-12 · Page-3 competitor sign-off',
    startIso: '2026-08-01T09:00:00.000Z',
    endIso: '2026-08-01T10:00:00.000Z',
  });
  assert.equal(task.transparency, 'transparent');

  const travel = timedEventBody({
    summary: 'MC 🚗 Travel out — Kenilworth',
    startIso: '2026-08-01T09:00:00.000Z',
    endIso: '2026-08-01T10:00:00.000Z',
  });
  assert.equal(travel.transparency, 'opaque');
});
