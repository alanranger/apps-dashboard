import { createRequire } from 'module';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { simulateDayPlacement, priorityRank, PRIORITY_ORDER } = require('../../api/mc/priority-lib.js');

describe('mc_priority rank', () => {
  it('orders p0 highest through p5 lowest', () => {
    for (let i = 0; i < PRIORITY_ORDER.length - 1; i += 1) {
      assert.ok(priorityRank(PRIORITY_ORDER[i]) < priorityRank(PRIORITY_ORDER[i + 1]));
    }
  });
});

describe('priority placement — cap competition', () => {
  it('p0 displaces p2 when cap is short; displaced rolls forward', () => {
    const items = [
      { kind: 'task', id: 1, title: 'Low', priority: 'p2', duration_min: 180 },
      { kind: 'task', id: 2, title: 'High', priority: 'p0', duration_min: 180 },
    ];
    const result = simulateDayPlacement(items, 240);
    assert.equal(result.placed.length, 1);
    assert.equal(result.placed[0].priority, 'p0');
    assert.equal(result.displaced.length, 1);
    assert.equal(result.displaced[0].priority, 'p2');
    assert.equal(result.displaced[0].roll_forward, true);
    assert.equal(result.displaced[0].reason, 'lower_priority_than_cap');
  });

  it('tasks and habits compete on the same day', () => {
    const items = [
      { kind: 'habit', id: 'h1', title: 'Accounts', priority: 'p1', duration_min: 120 },
      { kind: 'task', id: 99, title: 'Money walkthrough', priority: 'p0', duration_min: 150 },
      { kind: 'habit', id: 'h2', title: 'Blog', priority: 'p3', duration_min: 60 },
    ];
    const result = simulateDayPlacement(items, 240);
    assert.deepEqual(result.placed.map((x) => x.priority), ['p0', 'p3']);
    assert.equal(result.displaced.length, 1);
    assert.equal(result.displaced[0].priority, 'p1');
  });
});
