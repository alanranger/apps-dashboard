import assert from 'node:assert/strict';
import {
  parseBuilder, buildRrule, humanCadence, idealsInHorizon, setPhaseStart, dowCodeFromYmd,
} from '../../mc/rrule.js';

const b = parseBuilder('FREQ=WEEKLY;INTERVAL=8;BYDAY=WE');
assert.equal(b.pattern, 'weekly');
assert.equal(b.interval, 8);
assert.equal(b.byday, 'WE');
assert.equal(buildRrule(b), 'FREQ=WEEKLY;INTERVAL=8;BYDAY=WE');
assert.equal(humanCadence(b), 'Every 8 weeks on Wednesday');

const phased = setPhaseStart(buildRrule(b), '2026-08-26');
assert.match(phased, /X-PHASE-START=2026-08-26/);
const ideals = idealsInHorizon(phased, '2026-08-24', '2027-02-01', 20);
assert.deepEqual(ideals, ['2026-08-26', '2026-10-21', '2026-12-16']);

assert.equal(dowCodeFromYmd('2026-08-26'), 'WE');

const q = parseBuilder('FREQ=MONTHLY;INTERVAL=3;BYDAY=3SA');
assert.equal(q.pattern, 'monthly_nth');
assert.equal(humanCadence({ ...q, byday: 'WE', nth: 3 }), '3rd Wednesday every 3 months');

console.log('rrule-builder-phase.test.mjs OK');
