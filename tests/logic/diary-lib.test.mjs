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

describe('diary calendar feeds', () => {
  it('colours workshops vs lessons from calendar id', () => {
    const { busyToBlocks } = require('../../api/mc/diary-lib.js');
    const { splitMcAndBusy } = require('../../api/mc/rule-breach-lib.js');
    const events = [
      {
        id: '1', summary: 'Composition Class x 3',
        start: { dateTime: '2026-07-30T18:00:00Z' }, end: { dateTime: '2026-07-30T20:00:00Z' },
        _calendarId: 'nht93uaqhhd191kc3fg1kjs57k6bunhn@import.calendar.google.com',
      },
      {
        id: '2', summary: 'Long Exposure Workshop',
        start: { dateTime: '2026-08-01T17:00:00Z' }, end: { dateTime: '2026-08-01T20:00:00Z' },
        _calendarId: 'ic364d06u5bjt60d91q0nrqps6ulk7b2@import.calendar.google.com',
      },
    ];
    const split = splitMcAndBusy(events);
    assert.ok(split.busy[0]._calendarId, 'busy must keep _calendarId');
    const blocks = busyToBlocks(split.busy, []);
    assert.equal(blocks.find((b) => /Composition/.test(b.title)).kind, 'lesson');
    assert.equal(blocks.find((b) => /Long Exposure/.test(b.title)).kind, 'workshop');
  });

  it('Zoom 1-2-1 is purple client booking + locked P0 even on Lessons feed', () => {
    const { busyToBlocks, isZoomClientBooking } = require('../../api/mc/diary-lib.js');
    assert.equal(
      isZoomClientBooking('Jo Galloway: Online 1-2-1 Tuition - Zoom'),
      true,
    );
    const blocks = busyToBlocks([{
      id: 'jo',
      summary: 'Jo Galloway: Online 1-2-1 Tuition - Zoom',
      start: '2026-08-12T14:00:00Z',
      end: '2026-08-12T15:00:00Z',
      _calendarId: 'nht93uaqhhd191kc3fg1kjs57k6bunhn@import.calendar.google.com',
    }], []);
    assert.equal(blocks[0].kind, 'workshop');
    assert.equal(blocks[0].slot_pinned, true);
    assert.equal(blocks[0].priority, 'p0');
    assert.equal(blocks[0].client_fixed, true);
  });

  it('fixture flanks become pre/post-match buffer blocks', () => {
    const { fixtureFlanksToBlocks } = require('../../api/mc/diary-lib.js');
    const blocks = fixtureFlanksToBlocks([{
      fixture_event_id: 'fx1',
      title: '⚽️ Ipswich Town vs Sunderland',
      fixture_start: '2026-08-22T14:00:00.000Z',
      fixture_end: '2026-08-22T16:00:00.000Z',
      block_start: '2026-08-22T13:00:00.000Z',
      block_end: '2026-08-22T17:00:00.000Z',
    }]);
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].kind, 'buffer');
    assert.match(blocks[0].title, /pre-match/);
    assert.match(blocks[1].title, /post-match/);
  });

  it('all-day busy and bank_holidays map into banners', () => {
    const { allDayBannersFromBusy, holidayMapFromRows } = require('../../api/mc/diary-lib.js');
    const banners = allDayBannersFromBusy([{
      id: '1', summary: 'August Bank Holiday (Regional Holiday); England',
      start: { date: '2026-08-31' }, end: { date: '2026-09-01' },
    }]);
    assert.equal(banners[0].day, '2026-08-31');
    const hol = holidayMapFromRows([{ holiday_date: '2026-08-31', title: 'Summer bank holiday' }]);
    assert.equal(hol['2026-08-31'], 'Summer bank holiday');
  });

  it('day axis is 30-minute steps with taller grid', () => {
    const {
      AXIS_STEP_MIN, DAY_START_MIN, DAY_END_MIN, GRID_PX, PX_PER_STEP,
    } = require('../../api/mc/diary-lib.js');
    assert.equal(AXIS_STEP_MIN, 30);
    assert.equal(PX_PER_STEP, 36);
    assert.equal(GRID_PX, ((DAY_END_MIN - DAY_START_MIN) / 30) * 36);
    assert.ok(GRID_PX > 640, 'grid taller than old 640px hour axis');
  });

  it('diary_pin on recurring_log wins over ideal_time', () => {
    const { habitLogsToBlocks, parseDiaryPin } = require('../../api/mc/diary-lib.js');
    assert.deepEqual(
      parseDiaryPin('diary_pin:2026-08-10T09:00:00.000Z|2026-08-10T10:00:00.000Z'),
      { start: '2026-08-10T09:00:00.000Z', end: '2026-08-10T10:00:00.000Z' },
    );
    const habitId = 'h1';
    const habitMap = new Map([[habitId, {
      id: habitId, title: 'Hotel check', duration_min: 45, ideal_time: '10:00:00', priority: 'p1',
    }]]);
    const blocks = habitLogsToBlocks([{
      recurring_task_id: habitId,
      scheduled_date: '2026-08-10',
      ideal_date: '2026-08-10',
      change: 'diary_pin:2026-08-10T13:00:00.000Z|2026-08-10T13:45:00.000Z',
      at: '2026-07-26T12:00:00Z',
    }], habitMap);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].start, '2026-08-10T13:00:00.000Z');
    assert.equal(blocks[0].editable, true);
  });

  it('hides skipped occurrence; keeps completed visible at actual minutes', () => {
    const { habitLogsToBlocks, parseCompleteMeta, isSkippedChange } = require('../../api/mc/diary-lib.js');
    assert.equal(isSkippedChange('skipped 2026-07-27'), true);
    assert.deepEqual(parseCompleteMeta('completed 2026-07-27|actual=40'), {
      date: '2026-07-27', actual_min: 40,
    });
    const habitId = 'h2';
    const habitMap = new Map([[habitId, {
      id: habitId, title: 'Schema', duration_min: 60, ideal_time: '09:00:00',
      last_done: '2026-07-27',
    }]]);
    const skipped = habitLogsToBlocks([{
      recurring_task_id: habitId,
      scheduled_date: '2026-07-26',
      ideal_date: '2026-07-27',
      change: 'skipped 2026-07-27',
    }], habitMap);
    assert.equal(skipped.length, 0);
    const done = habitLogsToBlocks([{
      recurring_task_id: habitId,
      scheduled_date: '2026-07-26',
      ideal_date: '2026-07-27',
      change: 'completed 2026-07-27|actual=40',
    }], habitMap);
    assert.equal(done.length, 1);
    assert.equal(done[0].done, true);
    assert.equal(done[0].actual_minutes, 40);
    assert.equal(done[0].editable, false);
    assert.equal(done[0].duration_min, 40);
  });
});

describe('week capacity — real load', () => {
  const rules = {
    working_hours_weekday_start: '10:00',
    working_hours_weekday_end: '17:00',
    working_hours_weekend_start: '11:00',
    working_hours_weekend_end: '16:00',
  };

  it('away days use residential 05–22 and teaching days have no free admin', () => {
    const { weekCapacity } = require('../../api/mc/diary-lib.js');
    const days = ['2026-08-03', '2026-08-04', '2026-08-07'];
    const awayDays = { '2026-08-03': { label: 'AWAY' }, '2026-08-04': { label: 'AWAY' } };
    const blocks = [
      {
        day: '2026-08-07', kind: 'workshop', client_fixed: true,
        start_min: 9 * 60, end_min: 16 * 60, synthetic: false,
      },
      {
        day: '2026-08-07', kind: 'travel',
        start_min: 7 * 60, end_min: 9 * 60, synthetic: false,
      },
    ];
    const cap = weekCapacity(days, blocks, awayDays, rules, new Set());
    assert.equal(cap.away_days, 2);
    assert.equal(cap.teaching_days, 1);
    assert.equal(cap.breakdown_h.away, 34); // 2 × 17h
    assert.equal(cap.breakdown_min.away, 2 * 17 * 60);
    assert.ok(cap.breakdown_h.workshop > 0);
    assert.ok(cap.breakdown_h.travel > 0);
    // teaching day capacity == committed (no spare admin)
    assert.equal(cap.free_min, 0);
  });

  it('normal day includes evening catch-up unless evening fixture', () => {
    const { weekCapacity } = require('../../api/mc/diary-lib.js');
    const open = weekCapacity(['2026-08-07'], [], {}, rules, new Set());
    // Fri 10–17 (7h) + 19–21 (2h) = 9h
    assert.equal(open.available_min, 9 * 60);
    const withFix = weekCapacity(['2026-08-07'], [{
      day: '2026-08-07', kind: 'fixture', start_min: 19 * 60, end_min: 21 * 60, synthetic: false,
    }], {}, rules, new Set());
    assert.equal(withFix.available_min, 7 * 60);
    assert.equal(withFix.breakdown_h.fixture, 2);
  });
});

describe('gcal push related_id', () => {
  it('one net key per task/habit occurrence', () => {
    assert.equal(relatedIdForTask('abc'), 'gcal:task:abc');
    assert.equal(relatedIdForHabit('h1', '2026-08-15'), 'gcal:habit:h1:2026-08-15');
  });
});
