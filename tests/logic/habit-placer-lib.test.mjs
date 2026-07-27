import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  orderHabitsForPlacement,
  buildBusyIntervals,
  placeHabits,
  buildAmendments,
  provePlacement,
  londonYmdHmToUtcMs,
  habitGapTier,
  requiredGapMins,
  datedTasksToIntervals,
  findTaskBumps,
  placeBumpedTasks,
  awaySpansFromTravelBlocks,
  candidateDays,
} = require('../../api/mc/habit-placer-lib.js');

const rules = {
  daily_task_cap_min: '240',
  daily_task_cap_tolerance_min: '30',
  decompress_after_task_min: '30',
  admin_gap_min: '15',
  fixture_buffer_min: '60',
  working_days: 'mon,tue,wed,thu,fri,sat,sun',
  working_hours_weekday_start: '09:00',
  working_hours_weekday_end: '17:00',
  working_hours_weekend_start: '09:00',
  working_hours_weekend_end: '17:00',
  exclude_bank_holidays: 'false',
  title_prefix_fixture: 'MC ⚽',
};
const holidays = new Set();
const ipswich = 'c_0e7gnac3odl7ki0jfjiaedot9g@group.calendar.google.com';

const day1 = {
  id: 'h1', title: 'BAU Day 1', priority: 'p1', duration_min: 60,
  ideal_time: '10:00', window_days: 1, time_critical: false,
  rrule: 'FREQ=WEEKLY;BYDAY=MO',
};
const day2 = {
  id: 'h2', title: 'BAU Day 2', priority: 'p1', duration_min: 60,
  ideal_time: '10:00', window_days: 1, time_critical: false,
  rrule: 'FREQ=WEEKLY;BYDAY=TU',
};
const upload = {
  id: 'h3', title: 'Upload sites', priority: 'p1', duration_min: 60,
  ideal_time: '10:00', window_days: 2, time_critical: false,
  rrule: 'FREQ=WEEKLY;BYDAY=WE',
};
const deps = [
  { habit_id: 'h2', depends_on_habit_id: 'h1', dep_type: 'must_complete_first' },
  { habit_id: 'h3', depends_on_habit_id: 'h2', dep_type: 'within_hours', within_hours: 24 },
];

describe('habit-placer-lib — topology then hardest-first', () => {
  it('orders blockers before dependents even if dependent is p0', () => {
    const soft = { ...day1, priority: 'p2' };
    const hardDep = { ...day2, priority: 'p0' };
    const ordered = orderHabitsForPlacement([hardDep, soft], [
      { habit_id: hardDep.id, depends_on_habit_id: soft.id, dep_type: 'must_complete_first' },
    ]);
    assert.equal(ordered[0].id, soft.id);
    assert.equal(ordered[1].id, hardDep.id);
  });
});

describe('habit-placer-lib — busy map', () => {
  it('strips MC and MC ⚽; expands Ipswich by buffer', () => {
    const busy = buildBusyIntervals([
      {
        summary: 'MC 🔁 Blog', colorId: '10',
        start: { dateTime: '2026-08-10T10:00:00+01:00' },
        end: { dateTime: '2026-08-10T12:00:00+01:00' },
      },
      {
        summary: 'MC ⚽ Before: Ipswich', colorId: '10',
        start: { dateTime: '2026-08-22T14:00:00+01:00' },
        end: { dateTime: '2026-08-22T15:00:00+01:00' },
      },
      {
        summary: 'Ipswich Town vs Sunderland',
        _calendarId: ipswich,
        transparency: 'transparent',
        start: { dateTime: '2026-08-22T15:00:00+01:00' },
        end: { dateTime: '2026-08-22T17:00:00+01:00' },
      },
      {
        summary: 'Workshop',
        start: { dateTime: '2026-08-11T10:00:00+01:00' },
        end: { dateTime: '2026-08-11T16:00:00+01:00' },
      },
    ], rules);
    assert.equal(busy.length, 2);
    assert.ok(busy.some((b) => b.summary.includes('Workshop')));
    const fix = busy.find((b) => b.summary.includes('Ipswich Town'));
    assert.ok(fix);
    // 15:00–17:00 London ±60m → 14:00–18:00
    assert.equal(isoHm(fix.startMs), '14:00');
    assert.equal(isoHm(fix.endMs), '18:00');
  });
});

function isoHm(ms) {
  const { isoToLondonMinutes } = require('../../api/mc/scheduling-rules-lib.js');
  const m = isoToLondonMinutes(new Date(ms).toISOString());
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

describe('habit-placer-lib — place + §5 proof', () => {
  it('places chain with no overlaps and deps held', () => {
    // Horizon covering one Mon–Wed: 2026-08-10 Mon … 2026-08-12 Wed
    const from = '2026-08-10';
    const to = '2026-08-16';
    const clientBusy = buildBusyIntervals([{
      summary: 'Client shoot',
      start: { dateTime: '2026-08-11T13:00:00+01:00' },
      end: { dateTime: '2026-08-11T15:00:00+01:00' },
    }], rules);
    const { placements, unplaced } = placeHabits(
      [upload, day2, day1], deps, clientBusy.slice(), rules, holidays, from, to,
    );
    assert.equal(unplaced.length, 0);
    assert.ok(placements.length >= 3);
    const proof = provePlacement(placements, clientBusy, deps, rules);
    assert.equal(proof.ok, true, proof.fails.join('; '));
  });

  it('does not sit a habit on client busy', () => {
    const habit = {
      id: 'hx', title: 'Joining', priority: 'p0', duration_min: 60,
      ideal_time: '10:00', window_days: 0, time_critical: false,
      rrule: 'FREQ=WEEKLY;BYDAY=TU',
    };
    const clientBusy = [{
      startMs: londonYmdHmToUtcMs('2026-08-11', '09:00'),
      endMs: londonYmdHmToUtcMs('2026-08-11', '17:00'),
      summary: 'all day client',
    }];
    const { placements, unplaced } = placeHabits(
      [habit], [], clientBusy.slice(), rules, holidays, '2026-08-11', '2026-08-11',
    );
    assert.equal(placements.length, 0);
    assert.equal(unplaced.length, 1);
  });

  it('KEEP when existing matches plan; MOVE when shifted', () => {
    const planned = [{
      habit_id: 'h1', title: 'A', ideal_date: '2026-08-10',
      startIso: '2026-08-10T09:00:00.000Z', endIso: '2026-08-10T10:00:00.000Z',
    }];
    const keep = buildAmendments(planned, [{
      ...planned[0], calendar_event_id: 'ev1',
    }]);
    assert.equal(keep[0].action, 'KEEP');
    const move = buildAmendments(planned, [{
      habit_id: 'h1', title: 'A', ideal_date: '2026-08-10',
      startIso: '2026-08-10T08:00:00.000Z', endIso: '2026-08-10T09:00:00.000Z',
      calendar_event_id: 'ev1',
    }]);
    assert.equal(move[0].action, 'MOVE');
  });

  it('KEEP when London wall clock matches despite different ISO offset strings', () => {
    const planned = [{
      habit_id: 'h1', title: 'A', ideal_date: '2026-09-03',
      startIso: '2026-09-03T09:00:00.000Z', endIso: '2026-09-03T12:00:00.000Z',
    }];
    const keep = buildAmendments(planned, [{
      habit_id: 'h1', title: 'A', ideal_date: '2026-09-03',
      startIso: '2026-09-03T10:00:00+01:00', endIso: '2026-09-03T13:00:00+01:00',
      calendar_event_id: 'ev1',
    }]);
    assert.equal(keep[0].action, 'KEEP');
  });

  it('skips past-dated amendments when fromYmd set', () => {
    const planned = [{
      habit_id: 'h1', title: 'A', ideal_date: '2026-07-24',
      startIso: '2026-07-24T09:00:00.000Z', endIso: '2026-07-24T10:00:00.000Z',
      day: '2026-07-24', duration_min: 60,
    }];
    const all = buildAmendments(planned, []);
    assert.equal(all.length, 1);
    const filtered = buildAmendments(planned, [], '2026-07-25');
    assert.equal(filtered.length, 0);
  });
});

describe('habit-placer-lib — tiered gaps', () => {
  it('classifies admin vs Publish Blog substantial', () => {
    assert.equal(habitGapTier('Upload sites — LocalViking'), 'admin');
    assert.equal(habitGapTier('BAU global refresh — Day 1'), 'admin');
    assert.equal(habitGapTier('Publish Blog Post'), 'substantial');
    assert.equal(requiredGapMins('Upload sites', 'SEO Performance Review', rules), 15);
    assert.equal(requiredGapMins('Publish Blog Post', 'Upload sites', rules), 30);
  });

  it('never places two admin habits back-to-back (needs ≥15m)', () => {
    const a = {
      id: 'a1', title: 'SEO Performance Review', priority: 'p1', duration_min: 60,
      ideal_time: '10:00', window_days: 0, time_critical: false,
      rrule: 'FREQ=WEEKLY;BYDAY=TU',
    };
    const b = {
      id: 'a2', title: 'Upload sites — LocalViking', priority: 'p2', duration_min: 60,
      ideal_time: '11:00', window_days: 0, time_critical: false,
      rrule: 'FREQ=WEEKLY;BYDAY=TU',
    };
    const { placements } = placeHabits(
      [a, b], [], [], rules, holidays, '2026-08-11', '2026-08-11',
    );
    assert.equal(placements.length, 2);
    const sorted = placements.slice().sort((x, y) => Date.parse(x.startIso) - Date.parse(y.startIso));
    const gap = (Date.parse(sorted[1].startIso) - Date.parse(sorted[0].endIso)) / 60000;
    assert.ok(gap >= 15, `gap ${gap}`);
    const proof = provePlacement(placements, [], [], rules);
    assert.equal(proof.ok, true, proof.fails.join('; '));
  });
});

describe('habit-placer-lib — dated tasks', () => {
  it('pinned tasks are hard busy; unpinned become bumps when habit overlaps', () => {
    const tasks = [
      {
        display_id: 8, title: 'Rev-weighting', state: 'todo', slot_pinned: false,
        scheduled_start: '2026-08-11T10:00:00+01:00', scheduled_end: '2026-08-11T12:00:00+01:00',
      },
      {
        display_id: 99, title: 'Pinned', state: 'todo', slot_pinned: true,
        scheduled_start: '2026-08-11T14:00:00+01:00', scheduled_end: '2026-08-11T15:00:00+01:00',
      },
    ];
    const soft = datedTasksToIntervals(tasks, { pinnedOnly: false });
    const pinned = datedTasksToIntervals(tasks, { pinnedOnly: true });
    assert.equal(soft.length, 1);
    assert.equal(pinned.length, 1);

    const habit = {
      id: 'hx', title: 'BAU global refresh — Day 1', priority: 'p1', duration_min: 60,
      ideal_time: '10:00', window_days: 0, time_critical: false,
      rrule: 'FREQ=WEEKLY;BYDAY=TU',
    };
    const { placements } = placeHabits(
      [habit], [], pinned.slice(), rules, holidays, '2026-08-11', '2026-08-11',
    );
    assert.equal(placements.length, 1);
    const bumps = findTaskBumps(placements, soft);
    assert.equal(bumps.length, 1);
    assert.equal(bumps[0].display_id, 8);
    const proof = provePlacement(placements, pinned, [], rules, { softTaskIntervals: soft, bumps });
    assert.equal(proof.ok, true, proof.fails.join('; '));
  });

  it('schedules bumped tasks into a concrete gap (no pick-a-slot)', () => {
    const { placeBumpedTasks } = require('../../api/mc/habit-placer-lib.js');
    const soft = datedTasksToIntervals([{
      display_id: 8, title: 'Rev-weighting', state: 'todo', slot_pinned: false,
      scheduled_start: '2026-08-11T10:00:00+01:00', scheduled_end: '2026-08-11T11:00:00+01:00',
    }], { pinnedOnly: false });
    const placements = [{
      habit_id: 'h', title: 'BAU global refresh — Day 1', day: '2026-08-11',
      startIso: new Date(londonYmdHmToUtcMs('2026-08-11', '10:00')).toISOString(),
      endIso: new Date(londonYmdHmToUtcMs('2026-08-11', '14:00')).toISOString(),
      duration_min: 240,
    }];
    const bumps = findTaskBumps(placements, soft);
    const { scheduled, unplaced } = placeBumpedTasks(
      bumps, soft, [], placements, rules, holidays, '2026-08-11',
    );
    assert.equal(unplaced.length, 0);
    assert.equal(scheduled.length, 1);
    assert.ok(scheduled[0].new_start);
    assert.ok(Date.parse(scheduled[0].new_start) >= Date.parse(placements[0].endIso));
  });

  it('pulls dependents when blocker is bumped and places them after', () => {
    const { placeBumpedTasks } = require('../../api/mc/habit-placer-lib.js');
    const soft = datedTasksToIntervals([
      {
        display_id: 21, title: 'Funds', state: 'todo', slot_pinned: false,
        scheduled_start: '2026-08-11T10:00:00+01:00', scheduled_end: '2026-08-11T10:15:00+01:00',
        depends_on_display_id: null,
      },
      {
        display_id: 22, title: 'Card move', state: 'todo', slot_pinned: false,
        scheduled_start: '2026-08-11T12:45:00+01:00', scheduled_end: '2026-08-11T13:30:00+01:00',
        depends_on_display_id: 21,
      },
    ], { pinnedOnly: false });
    const placements = [{
      habit_id: 'h', title: 'Send Out Joining Details', day: '2026-08-11',
      startIso: new Date(londonYmdHmToUtcMs('2026-08-11', '10:00')).toISOString(),
      endIso: new Date(londonYmdHmToUtcMs('2026-08-11', '11:00')).toISOString(),
      duration_min: 60,
    }];
    const bumps = findTaskBumps(placements, soft);
    assert.ok(bumps.some((b) => Number(b.display_id) === 21));
    assert.ok(bumps.some((b) => Number(b.display_id) === 22), '22 pulled with 21');
    const { scheduled } = placeBumpedTasks(
      bumps, soft, [], placements, rules, holidays, '2026-08-11',
    );
    const b21 = scheduled.find((s) => Number(s.display_id) === 21);
    const b22 = scheduled.find((s) => Number(s.display_id) === 22);
    assert.ok(b21 && b22);
    assert.ok(Date.parse(b22.new_start) >= Date.parse(b21.new_end));
  });
});

describe('habit-placer-lib — away spans', () => {
  it('derives multi-day span; skips same-day day-trips; no travel-based rest', () => {
    const spans = awaySpansFromTravelBlocks([
      {
        block_type: 'travel_out', venue_name: 'Rosedale Abbey',
        workshop_start: '2026-08-03T11:00:00Z',
        starts_at: '2026-08-03T08:00:00Z', ends_at: '2026-08-03T11:15:00Z',
      },
      {
        block_type: 'travel_back', venue_name: 'Rosedale Abbey',
        workshop_start: '2026-08-03T11:00:00Z',
        starts_at: '2026-08-06T13:00:00Z', ends_at: '2026-08-06T16:15:00Z',
      },
      {
        block_type: 'travel_out', venue_name: 'Burnham',
        workshop_start: '2026-08-01T17:45:00Z',
        starts_at: '2026-08-01T15:00:00Z', ends_at: '2026-08-01T17:15:00Z',
      },
      {
        block_type: 'travel_back', venue_name: 'Burnham',
        workshop_start: '2026-08-01T17:45:00Z',
        starts_at: '2026-08-01T20:15:00Z', ends_at: '2026-08-01T22:30:00Z',
      },
    ]);
    assert.equal(spans.length, 1);
    assert.equal(spans[0].startDay, '2026-08-03');
    assert.equal(spans[0].endDay, '2026-08-06');
    assert.equal(spans[0].restDay, null);
  });

  it('rest day = day after last day of multi-day workshop event (not travel/Sunday)', () => {
    const {
      restDaySpansFromWorkshopEvents, multidayWorkshopRestRows, dayBlockedForPlacement,
    } = require('../../api/mc/habit-placer-lib.js');
    const events = [
      {
        id: 'ward',
        summary: 'Post Processing Masterclass - David Ward',
        _calendarId: 'primary',
        start: { dateTime: '2026-08-04T08:00:00Z' },
        end: { dateTime: '2026-08-06T16:00:00Z' },
      },
      {
        id: 'macro',
        summary: 'Abstract and Macro',
        _calendarId: 'ic364d06abc@group.calendar.google.com',
        start: { dateTime: '2026-08-23T09:30:00Z' },
        end: { dateTime: '2026-08-23T11:30:00Z' },
      },
    ];
    const rows = multidayWorkshopRestRows(events);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].lastDay, '2026-08-06');
    assert.equal(rows[0].restDay, '2026-08-07');
    const rests = restDaySpansFromWorkshopEvents(events, {
      rest_day_after_multiday_workshop: 'true',
    });
    assert.equal(rests.length, 1);
    assert.equal(rests[0].restDay, '2026-08-07');
    assert.equal(dayBlockedForPlacement('2026-08-07', rests), true);
    assert.equal(dayBlockedForPlacement('2026-08-24', rests), false);
  });

  it('rolls ideal away-day past multi-day workshop rest day', () => {
    const {
      restDaySpansFromWorkshopEvents, awaySpansFromTravelBlocks, candidateDays,
    } = require('../../api/mc/habit-placer-lib.js');
    const away = awaySpansFromTravelBlocks([
      {
        block_type: 'travel_out', venue_name: 'Norfolk',
        workshop_start: '2026-11-20T09:30:00Z',
        starts_at: '2026-11-20T05:30:00Z', ends_at: '2026-11-20T09:00:00Z',
      },
      {
        block_type: 'travel_back', venue_name: 'Norfolk',
        workshop_start: '2026-11-20T09:30:00Z',
        starts_at: '2026-11-22T14:00:00Z', ends_at: '2026-11-22T17:30:00Z',
      },
    ]);
    assert.equal(away[0].restDay, null); // travel no longer invents rest
    const rests = restDaySpansFromWorkshopEvents([
      {
        summary: 'Blakeney Norfolk',
        _calendarId: 'ic364d06abc@group.calendar.google.com',
        start: { date: '2026-11-20' },
        end: { date: '2026-11-23' }, // exclusive → last Sun 22
      },
    ], { rest_day_after_multiday_workshop: 'true' });
    assert.equal(rests[0].restDay, '2026-11-23');
    const spans = away.concat(rests);
    const days = candidateDays('2026-11-22', 2, false, rules, holidays, spans);
    assert.ok(!days.includes('2026-11-20'));
    assert.ok(!days.includes('2026-11-21'));
    assert.ok(!days.includes('2026-11-22'));
    assert.ok(!days.includes('2026-11-23'));
    assert.ok(days.includes('2026-11-19') || days.includes('2026-11-24'));
  });

  it('does not place habit on middle away day; non-Sunday return has no travel rest day', () => {
    const spans = awaySpansFromTravelBlocks([
      {
        block_type: 'travel_out', venue_name: 'Rosedale Abbey',
        workshop_start: '2026-08-03T11:00:00Z',
        starts_at: '2026-08-03T08:00:00Z', ends_at: '2026-08-03T11:15:00Z',
      },
      {
        block_type: 'travel_back', venue_name: 'Rosedale Abbey',
        workshop_start: '2026-08-03T11:00:00Z',
        starts_at: '2026-08-06T13:00:00Z', ends_at: '2026-08-06T16:15:00Z',
      },
    ]);
    const habit = {
      id: 'hx', title: 'Hotel check', priority: 'p1', duration_min: 60,
      ideal_time: '10:00', window_days: 0, time_critical: false,
      rrule: 'FREQ=WEEKLY;BYDAY=WE;COUNT=1',
    };
    const { placements } = placeHabits(
      [{ ...habit, rrule: 'FREQ=DAILY;COUNT=1' }], [], spans, rules, holidays,
      '2026-08-05', '2026-08-05',
    );
    assert.ok(placements.every((p) => p.day < '2026-08-03' || p.day > '2026-08-06'));
  });

  it('does not place habit on teaching/client day', () => {
    const { teachingDaySpansFromEvents } = require('../../api/mc/habit-placer-lib.js');
    const teaching = teachingDaySpansFromEvents([{
      summary: 'Landscape workshop',
      _calendarId: 'ic364d06u5bjt60d91q0nrqps6ulk7b2@import.calendar.google.com',
      start: { dateTime: '2026-09-10T10:00:00+01:00' },
      end: { dateTime: '2026-09-10T16:00:00+01:00' },
    }]);
    assert.equal(teaching[0].startDay, '2026-09-10');
    const habit = {
      id: 'hy', title: 'BAU tick', priority: 'p2', duration_min: 30,
      ideal_time: '11:00', window_days: 0, time_critical: false,
      rrule: 'FREQ=DAILY;COUNT=1',
    };
    const { placements } = placeHabits(
      [habit], [], teaching, rules, holidays, '2026-09-10', '2026-09-10',
    );
    assert.ok(placements.every((p) => p.day !== '2026-09-10'));
  });
});
