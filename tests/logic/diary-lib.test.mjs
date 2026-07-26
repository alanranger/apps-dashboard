import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { warnDrop } = require('../../api/mc/diary-lib.js');
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

describe('gcal push related_id', () => {
  it('one net key per task/habit occurrence', () => {
    assert.equal(relatedIdForTask('abc'), 'gcal:task:abc');
    assert.equal(relatedIdForHabit('h1', '2026-08-15'), 'gcal:habit:h1:2026-08-15');
  });
});
