import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { collapsePushManifest } = require('../../api/mc/gcal-push-lib.js');

describe('collapsePushManifest', () => {
  it('complete supersedes earlier move for same habit+event', () => {
    const items = [
      {
        id: '1', entity_type: 'habit', change_kind: 'move', updated_at: '2026-07-26T16:00:00Z',
        related_id: 'gcal:habit:h1:2026-07-27',
        payload: {
          habit_id: 'h1', ideal_date: '2026-07-27',
          new_start: '2026-07-28T14:00:00.000Z',
          calendar_event_id: 'evt1',
        },
      },
      {
        id: '2', entity_type: 'habit', change_kind: 'complete', updated_at: '2026-07-26T17:00:00Z',
        related_id: 'gcal:habit:h1:evt:evt1',
        payload: {
          habit_id: 'h1', ideal_date: '2026-07-27', scheduled_date: '2026-07-28',
          calendar_event_id: 'evt1',
        },
      },
    ];
    const out = collapsePushManifest(items);
    assert.equal(out.length, 1);
    assert.equal(out[0].change_kind, 'complete');
  });

  it('keeps unrelated habit rows', () => {
    const items = [
      {
        id: '1', entity_type: 'habit', change_kind: 'move', updated_at: 'a',
        related_id: 'gcal:habit:h1:2026-07-27',
        payload: { habit_id: 'h1', ideal_date: '2026-07-27', new_start: '2026-07-28T14:00:00.000Z' },
      },
      {
        id: '2', entity_type: 'habit', change_kind: 'complete', updated_at: 'b',
        related_id: 'gcal:habit:h2:2026-07-26',
        payload: { habit_id: 'h2', ideal_date: '2026-07-26', scheduled_date: '2026-07-26' },
      },
    ];
    assert.equal(collapsePushManifest(items).length, 2);
  });
});
