/**
 * Place Dec-30 hotel ideals on a day with ZERO existing hotel-booking habits.
 * node scripts/mc-fix-dec30-hotels2.cjs --apply
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const APPLY = process.argv.includes('--apply');
const { sb } = require('../api/mc/_lib');
const { fetchHorizonEvents } = require('../api/mc/gcal-lib');
const { insertPrimaryEvent, deletePrimaryEvent, verifyPrimaryEvent } = require('../api/mc/gcal-write-lib');
const { habitGcalTitle } = require('../api/mc/gcal-title-lib');
const {
  awaySpansFromTravelBlocks, restDaySpansFromDbRows, restDaySpansFromWorkshopEvents,
  teachingDaySpansFromEvents, buildBusyIntervals, trySlotOnDay, dayBlockedForHabits,
} = require('../api/mc/habit-placer-lib');
const { ruleMapFromRows, bankHolidaySet, addDays, isoToLondonDate } = require('../api/mc/scheduling-rules-lib');

const PAIR = [
  { id: '4dd47c23-92a2-4d03-8474-4f557775e3a9', ideal: '2026-12-30' },
  { id: 'fc32dffb-6b5d-434b-86b9-d484ce434127', ideal: '2026-12-30' },
];

(async () => {
  const rules = await sb('scheduling_rules?select=key,value');
  const ruleMap = ruleMapFromRows(rules || []);
  const { events } = await fetchHorizonEvents('2026-12-20T00:00:00.000Z', '2027-01-20T00:00:00.000Z');
  const primary = (events || []).filter((e) => (e._calendarId || 'primary') === 'primary' && e.start?.dateTime);

  // Days that already have hotel booking habits
  const hotelDays = new Set();
  for (const e of primary) {
    if (/Hotel bookings/i.test(e.summary || '')) hotelDays.add(isoToLondonDate(e.start.dateTime));
  }
  console.log('hotelDays', [...hotelDays].sort());

  // Delete dead/dup Jan 5 force creates if they are the Dec30 log targets and a second exists
  for (const p of PAIR) {
    const logs = await sb(
      `recurring_log?recurring_task_id=eq.${p.id}&ideal_date=eq.${p.ideal}`
      + '&select=id,scheduled_date,calendar_event_id,change&order=at.desc&limit=1',
    );
    const row = logs?.[0];
    console.log('before', p.id.slice(0, 8), row?.scheduled_date, row?.calendar_event_id);
  }

  const travel = await sb('travel_blocks?select=*&block_type=in.(travel_out,travel_back)&starts_at=gte.2026-12-20T00:00:00Z&starts_at=lte.2027-01-20T23:59:59Z');
  const restDb = await sb('rest_day_blocks?status=eq.active&rest_date=gte.2026-12-20&rest_date=lte.2027-01-20&select=rest_date,workshop_title');
  const blocked = awaySpansFromTravelBlocks(travel || [])
    .concat(teachingDaySpansFromEvents(events || [], ruleMap))
    .concat(restDaySpansFromWorkshopEvents(events || [], ruleMap))
    .concat(restDaySpansFromDbRows(restDb || []));
  const busy = buildBusyIntervals(events || [], ruleMap).concat(blocked);
  for (const e of primary) {
    if (!/^MC\s*🔁/i.test(e.summary || '')) continue;
    busy.push({
      startMs: Date.parse(e.start.dateTime),
      endMs: Date.parse(e.end?.dateTime || e.start.dateTime),
      summary: e.summary,
    });
  }

  // Candidate days: 28 Dec .. 12 Jan excluding hotelDays and blocked
  const candidates = [];
  for (let i = 0; i < 20; i += 1) {
    const d = addDays('2026-12-28', i);
    if (hotelDays.has(d)) continue;
    if (dayBlockedForHabits(d, blocked)) continue;
    candidates.push(d);
  }
  console.log('candidates', candidates.slice(0, 10));

  const dayUsed = {};
  let chosenDay = null;
  for (const day of candidates) {
    // Need room for BOTH habits same day (deps)
    const h1 = (await sb(`recurring_tasks?id=eq.${PAIR[0].id}&select=*`))[0];
    const h2 = (await sb(`recurring_tasks?id=eq.${PAIR[1].id}&select=*`))[0];
    const t1 = trySlotOnDay(day, Number(h1.duration_min) || 45, h1.ideal_time || '10:00', h1.title, busy, [], dayUsed, ruleMap);
    if (!t1) continue;
    const busy2 = busy.concat([{
      startMs: Date.parse(t1.startIso), endMs: Date.parse(t1.endIso), summary: h1.title,
    }]);
    const used2 = { ...dayUsed, [day]: (dayUsed[day] || 0) + t1.durationMin };
    const t2 = trySlotOnDay(day, Number(h2.duration_min) || 45, h2.ideal_time || '11:00', h2.title, busy2, [], used2, ruleMap);
    if (!t2) continue;
    chosenDay = { day, t1, t2, h1, h2 };
    break;
  }
  if (!chosenDay) {
    console.log('NO DAY');
    process.exit(2);
  }
  console.log('chosen', chosenDay.day, chosenDay.t1.startIso, chosenDay.t2.startIso);

  if (!APPLY) return;

  // Remove prior Dec30 linked events if dead or on a hotelDay (dup day)
  for (const p of PAIR) {
    const logs = await sb(
      `recurring_log?recurring_task_id=eq.${p.id}&ideal_date=eq.${p.ideal}`
      + '&select=id,calendar_event_id&order=at.desc&limit=1',
    );
    const row = logs?.[0];
    if (row?.calendar_event_id) {
      try { await deletePrimaryEvent(row.calendar_event_id); } catch (_) { /* */ }
    }
  }

  const slots = [
    { p: PAIR[0], habit: chosenDay.h1, slot: chosenDay.t1 },
    { p: PAIR[1], habit: chosenDay.h2, slot: chosenDay.t2 },
  ];
  for (const s of slots) {
    const title = habitGcalTitle(s.habit.title, { habit: ruleMap.title_prefix_recurring || 'MC 🔁' });
    const evt = await insertPrimaryEvent({
      summary: title,
      description: `Mission Control habit — ${s.habit.title}`,
      startIso: s.slot.startIso,
      endIso: s.slot.endIso,
    });
    const logs = await sb(
      `recurring_log?recurring_task_id=eq.${s.p.id}&ideal_date=eq.${s.p.ideal}`
      + '&select=id&order=at.desc&limit=1',
    );
    const body = {
      scheduled_date: chosenDay.day,
      calendar_event_id: evt.id,
      change: `diary_pin:${s.slot.startIso}|${s.slot.endIso}`,
    };
    if (logs?.[0]?.id) {
      await sb(`recurring_log?id=eq.${logs[0].id}`, { method: 'PATCH', prefer: 'return=minimal', body });
    } else {
      await sb('recurring_log', {
        method: 'POST', prefer: 'return=minimal',
        body: { recurring_task_id: s.p.id, ideal_date: s.p.ideal, actor: 'cursor', ...body },
      });
    }
    console.log('wrote', s.habit.title, chosenDay.day, evt.id);
  }
})().catch((e) => { console.error(e); process.exit(1); });
