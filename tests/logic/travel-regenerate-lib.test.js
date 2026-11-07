const { desiredTravelTimes, planTravelRegenerate } = require('../../api/mc/travel-regenerate-lib');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const bounds = {
  startMs: Date.parse('2026-08-01T18:00:00.000Z'), // 19:00 London
  endMs: Date.parse('2026-08-01T20:30:00.000Z'), // 21:30 London
  startIso: '2026-08-01T18:00:00.000Z',
  endIso: '2026-08-01T20:30:00.000Z',
};
const d = desiredTravelTimes(bounds, 135, 30, {
  out: { starts_at: '2026-08-01T15:00:00.000Z', ends_at: '2026-08-01T17:15:00.000Z' },
  back: { starts_at: '2026-08-01T20:15:00.000Z', ends_at: '2026-08-01T22:30:00.000Z' },
});
assert(d.out.starts_at === '2026-08-01T15:15:00.000Z', `out start ${d.out.starts_at}`);
assert(d.out.ends_at === '2026-08-01T17:30:00.000Z', `out end ${d.out.ends_at}`);
assert(d.back.starts_at === '2026-08-01T20:30:00.000Z', `back start ${d.back.starts_at}`);
assert(d.back.ends_at === '2026-08-01T22:45:00.000Z', `back end ${d.back.ends_at}`);

const plan = planTravelRegenerate(
  [
    {
      id: '1', block_type: 'travel_out', starts_at: '2026-08-01T14:00:00.000Z',
      ends_at: '2026-08-01T16:15:00.000Z', venue_name: 'Burnham',
      workshop_title: 'Long Exposure Photography Workshop - Burnham',
      workshop_start: '2026-08-01T16:45:00.000Z', drive_minutes_used: 135,
      calendar_event_id: 'out1', workshop_row_key: null,
    },
    {
      id: '2', block_type: 'travel_back', starts_at: '2026-08-01T19:15:00.000Z',
      ends_at: '2026-08-01T21:30:00.000Z', venue_name: 'Burnham',
      workshop_title: 'Long Exposure Photography Workshop - Burnham',
      workshop_start: '2026-08-01T16:45:00.000Z', drive_minutes_used: 135,
      calendar_event_id: 'back1', workshop_row_key: null,
    },
  ],
  [{
    id: 'ws1',
    summary: 'Long Exposure Photography Workshop - Burnham on Sea Sunset',
    start: { dateTime: '2026-08-01T18:00:00.000Z' },
    end: { dateTime: '2026-08-01T20:30:00.000Z' },
    _calendarId: 'ic364d06abc',
  }],
  { arrive_before_start_min: 30 },
  [],
);
assert(plan.changed_count === 1, `changed ${plan.changed_count}`);
assert(plan.changes[0].out.times_changed === true, 'out times');
assert(plan.changes[0].workshop_row_key === 'gcal:ws1', 'row key');

// Same GCal id after a week+ reschedule must still link (Hartland-class move).
const moved = planTravelRegenerate(
  [
    {
      id: 'h1', block_type: 'travel_out', starts_at: '2027-02-18T08:30:00.000Z',
      ends_at: '2027-02-18T12:30:00.000Z', venue_name: 'Devon',
      workshop_title: 'Hartland Quay, Devon Seascape Photography Workshop',
      workshop_start: '2027-02-18T12:30:00.000Z', drive_minutes_used: 240,
      calendar_event_id: 'outH',
      workshop_row_key: 'gcal:_hartland_live_id',
    },
    {
      id: 'h2', block_type: 'travel_back', starts_at: '2027-02-21T12:30:00.000Z',
      ends_at: '2027-02-21T16:30:00.000Z', venue_name: 'Devon',
      workshop_title: 'Hartland Quay, Devon Seascape Photography Workshop',
      workshop_start: '2027-02-18T12:30:00.000Z', drive_minutes_used: 240,
      calendar_event_id: 'backH',
      workshop_row_key: 'gcal:_hartland_live_id',
    },
  ],
  [{
    id: '_hartland_live_id',
    summary: 'Hartland Quay, Devon Seascape Photography Workshop',
    start: { dateTime: '2027-02-25T12:30:00.000Z' },
    end: { dateTime: '2027-02-28T12:30:00.000Z' },
    _calendarId: 'ic364d06u5bjt60d91q0nrqps6ulk7b2@import.calendar.google.com',
  }],
  { arrive_before_start_min: 30 },
  [{ venue_name: 'Hartland Quay', minutes_from_home: 240 }],
);
assert(moved.unmatched.length === 0, `unmatched ${JSON.stringify(moved.unmatched)}`);
assert(moved.changed_count >= 1, `moved changed ${moved.changed_count}`);
assert(String(moved.changes[0].out.to.starts_at).startsWith('2027-02-25'), `out follows live ${moved.changes[0].out.to.starts_at}`);
console.log('travel-regenerate-lib ok');
