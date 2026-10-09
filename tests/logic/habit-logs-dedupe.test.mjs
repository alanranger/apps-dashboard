/**
 * habitLogsToBlocks must not paint two ideals that share one GCal event.
 */
import { createRequire } from 'module';
import test from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { habitLogsToBlocks } = require('../../api/mc/diary-lib');

test('dedupes two ideals sharing one calendar_event_id', () => {
  const habitId = '6ec9689d-5426-4276-9e17-824cb4ea4fc1';
  const evt = 'shared-event-id';
  const habitMap = new Map([[habitId, {
    id: habitId,
    title: 'Business Performance Review',
    duration_min: 120,
    ideal_time: '12:00',
    priority: 'p1',
    last_done: null,
  }]]);

  const logs = [
    {
      recurring_task_id: habitId,
      ideal_date: '2026-10-06',
      scheduled_date: '2026-10-12',
      calendar_event_id: evt,
      change: 'diary_pin:2026-10-12T09:00:00.000Z|2026-10-12T11:00:00.000Z',
      at: '2026-07-24T09:00:00.000Z',
    },
    {
      recurring_task_id: habitId,
      ideal_date: '2026-10-12',
      scheduled_date: '2026-10-12',
      calendar_event_id: evt,
      change: 'diary_pin:2026-10-12T10:00:00+01:00|2026-10-12T12:00:00.000Z',
      at: '2026-10-09T16:00:00.000Z',
    },
  ];

  const blocks = habitLogsToBlocks(logs, habitMap);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].ideal_date, '2026-10-12');
});
