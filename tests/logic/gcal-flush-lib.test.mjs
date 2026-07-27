import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  planFromPushRow, planFromBacklogRow, dedupePlans,
} = require('../../api/mc/gcal-flush-lib.js');

const prefixes = { habit: 'MC 🔁', travel: 'MC 🚗' };

describe('gcal-flush-lib — plan builders', () => {
  it('plans habit move as patch when event id present', () => {
    const plan = planFromPushRow({
      id: 'q1', entity_type: 'habit', change_kind: 'move', summary: 'Move',
      payload: {
        title: 'Booking Sheet', new_start: '2026-08-03T08:00:00.000Z',
        new_end: '2026-08-03T09:00:00.000Z', calendar_event_id: 'evt1',
      },
    }, prefixes);
    assert.equal(plan.action, 'patch');
    assert.equal(plan.event_id, 'evt1');
    assert.match(plan.summary, /MC 🔁/);
  });

  it('orders complete/skip as delete', () => {
    const skip = planFromPushRow({
      id: 'q2', entity_type: 'habit', change_kind: 'skip', summary: 'Skip',
      payload: { action: 'delete_event', calendar_event_id: 'evt2' },
    }, prefixes);
    assert.equal(skip.action, 'delete');
  });

  it('parses backlog DELETE lines', () => {
    const plan = planFromBacklogRow({
      id: 'b1', summary: 'Remove', related_id: 'x',
      proposed_action: 'DELETE Primary event abc123 (2026-09-22 10:00–14:00).',
    });
    assert.equal(plan.action, 'delete');
    assert.equal(plan.event_id, 'abc123');
  });

  it('prefers queue over backlog for same event', () => {
    const plans = dedupePlans([
      {
        source: 'pending_diary_changes', source_id: 'b', action: 'patch',
        event_id: 'e1', summary: 'old',
      },
      {
        source: 'gcal_push_queue', source_id: 'q', action: 'patch',
        event_id: 'e1', summary: 'new',
      },
    ]);
    assert.equal(plans.length, 1);
    assert.equal(plans[0].source, 'gcal_push_queue');
  });
});
