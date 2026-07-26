import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  warnDrop, mondayOnOrBefore, weeksFrom, insertDecompressStrips, travelToBlocks,
} = require('../../api/mc/diary-lib.js');
const { relatedIdForTask, relatedIdForHabit } = require('../../api/mc/gcal-push-lib.js');

describe('diary warnDrop', () => {
  it('flags away + decompress via placer requiredGapMins', () => {
    const ruleMap = {
      daily_task_cap_min: '240',
      daily_task_cap_tolerance_min: '30',
      decompress_after_task_min: '30',
      admin_gap_min: '15',
    };
    const peers = [{
      day: '2026-08-10', title: 'MC-1 Admin', start_min: 10 * 60, end_min: 11 * 60,
    }];
    const awaySpans = [{ startDay: '2026-08-10', endDay: '2026-08-12' }];
    const r = warnDrop({
      title: 'MC-2 Work',
      day: '2026-08-10',
      startMin: 11 * 60,
      endMin: 12 * 60,
      peers,
      ruleMap,
      awaySpans,
      pinned: false,
    });
    assert.equal(r.blocked, false);
    assert.ok(r.warnings.some((w) => /Away-span/.test(w)));
    assert.ok(r.warnings.some((w) => /Decompress buffer/.test(w) && /requiredGapMins/.test(w)));
  });

  it('blocks pinned drag', () => {
    const r = warnDrop({
      title: 'x', day: '2026-08-10', startMin: 600, endMin: 660,
      peers: [], ruleMap: {}, awaySpans: [], pinned: true,
    });
    assert.equal(r.blocked, true);
  });
});

describe('diary weeks Mon-Sun', () => {
  it('snaps Sunday to prior Monday', () => {
    assert.equal(mondayOnOrBefore('2026-07-26'), '2026-07-20');
  });
  it('weeks start Monday end Sunday', () => {
    const weeks = weeksFrom('2026-07-26', 1);
    assert.equal(weeks[0].days[0], '2026-07-20');
    assert.equal(weeks[0].days[6], '2026-07-26');
  });
});

describe('diary buffers', () => {
  it('prep/decompress travel becomes buffer kind', () => {
    const blocks = travelToBlocks([
      {
        id: '1', block_type: 'decompress', starts_at: '2026-07-27T12:00:00Z',
        ends_at: '2026-07-27T12:30:00Z', calendar_event_id: 'x',
      },
      {
        id: '2', block_type: 'travel_out', starts_at: '2026-07-27T08:00:00Z',
        ends_at: '2026-07-27T09:00:00Z', calendar_event_id: 'y',
      },
    ]);
    assert.equal(blocks[0].kind, 'buffer');
    assert.equal(blocks[1].kind, 'travel');
  });

  it('inserts decompress strips between appointments', () => {
    const strips = insertDecompressStrips([
      {
        id: 'task:1', kind: 'mc_task', title: 'A', day: '2026-07-27',
        start_min: 600, end_min: 660, start: 'x', end: 'y',
      },
      {
        id: 'task:2', kind: 'mc_task', title: 'B', day: '2026-07-27',
        start_min: 720, end_min: 780, start: 'x', end: 'y',
      },
    ], { decompress_after_task_min: '30' });
    const gaps = strips.filter((b) => b.synthetic);
    assert.ok(gaps.length >= 1);
    assert.equal(gaps[0].kind, 'buffer');
  });
});

describe('gcal push related_id', () => {
  it('one net key per task/habit occurrence', () => {
    assert.equal(relatedIdForTask('abc'), 'gcal:task:abc');
    assert.equal(relatedIdForHabit('h1', '2026-08-15'), 'gcal:habit:h1:2026-08-15');
  });
});
