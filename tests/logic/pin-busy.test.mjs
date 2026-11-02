import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { wantedTransparency } = require('../../api/mc/gcal-write-lib.js');
const { loadPinnedEventIds } = require('../../api/mc/pin-busy-lib.js');

describe('pinned items show as Busy', () => {
  it('pinned MC 🔁 event is Busy; unpinned MC block stays Free; non-MC untouched', () => {
    const busyIds = new Set(['pinned1']);
    assert.equal(wantedTransparency({ id: 'pinned1', summary: 'MC 🔁 Monthly Accounts — Bank Genie' }, busyIds), 'opaque');
    assert.equal(wantedTransparency({ id: 'other', summary: 'MC 🔁 Publish Blog Post' }, busyIds), 'transparent');
    assert.equal(wantedTransparency({ id: 'x', summary: 'Dentist' }, busyIds), null);
    assert.equal(wantedTransparency({ id: 'pinned1', summary: 'MC 🔁 Bank Genie' }, null), 'transparent');
  });

  it('collects event ids from habit pins and pinned tasks', async () => {
    const calls = [];
    const sb = async (q) => {
      calls.push(q);
      if (q.startsWith('recurring_log')) return [{ calendar_event_id: 'h1' }, { calendar_event_id: null }];
      if (q.startsWith('tasks')) return [{ calendar_event_id: 't1' }];
      return [];
    };
    const ids = await loadPinnedEventIds(sb, '2026-11-01');
    assert.deepEqual([...ids].sort(), ['h1', 't1']);
    assert.ok(calls[0].includes('roll_reason=eq.diary_manual_pin'));
    assert.ok(calls[1].includes('slot_pinned=eq.true'));
  });
});
