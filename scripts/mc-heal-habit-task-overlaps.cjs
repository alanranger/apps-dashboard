/**
 * Heal remaining habit×task overlaps: move the lower-priority flexible block.
 * Habits move when task priority ≥ habit priority; else bump is placer's job.
 * node scripts/mc-heal-habit-task-overlaps.cjs --apply
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
const { patchPrimaryEvent } = require('../api/mc/gcal-write-lib');
const {
  trySlotOnDay, awaySpansFromTravelBlocks, restDaySpansFromDbRows,
  restDaySpansFromWorkshopEvents, teachingDaySpansFromEvents, buildBusyIntervals,
  dayBlockedForHabits,
} = require('../api/mc/habit-placer-lib');
const { ruleMapFromRows, bankHolidaySet, addDays, isoToLondonDate } = require('../api/mc/scheduling-rules-lib');
const { londonToday } = require('../api/mc/diary-lib');
const { priorityRank } = require('../api/mc/priority-lib');

function overlaps(a0, a1, b0, b1) {
  return a0 < b1 && b0 < a1;
}

(async () => {
  const today = londonToday();
  const to = addDays(today, 180);
  const rules = await sb('scheduling_rules?select=key,value');
  const ruleMap = ruleMapFromRows(rules || []);
  const { events } = await fetchHorizonEvents(`${today}T00:00:00.000Z`, `${to}T23:59:59.000Z`);
  const primary = (events || []).filter((e) => (e._calendarId || 'primary') === 'primary' && e.start?.dateTime);

  const habits = await sb('recurring_tasks?select=id,title,priority,duration_min,ideal_time&active=eq.true');
  const tasks = await sb(
    'tasks?select=display_id,title,priority,scheduled_start,scheduled_end,calendar_event_id,slot_pinned,state'
    + `&scheduled_start=gte.${today}T00:00:00Z&scheduled_start=lte.${to}T23:59:59Z`
    + '&state=not.in.(done,verified,wont_do,superseded)',
  );
  const habitByTitle = new Map((habits || []).map((h) => [h.title.toLowerCase(), h]));

  const travel = await sb(`travel_blocks?select=*&block_type=in.(travel_out,travel_back)&starts_at=gte.${today}T00:00:00Z&starts_at=lte.${to}T23:59:59Z`);
  const restDb = await sb(`rest_day_blocks?status=eq.active&rest_date=gte.${today}&rest_date=lte.${to}&select=rest_date,workshop_title`);
  const blocked = awaySpansFromTravelBlocks(travel || [])
    .concat(teachingDaySpansFromEvents(events || [], ruleMap))
    .concat(restDaySpansFromWorkshopEvents(events || [], ruleMap))
    .concat(restDaySpansFromDbRows(restDb || []));
  const busy = buildBusyIntervals(events || [], ruleMap).concat(blocked);
  for (const e of primary) {
    if (!/^MC\s/i.test(e.summary || '') && !/^P\d\s*·\s*MC-/i.test(e.summary || '')) continue;
    busy.push({
      startMs: Date.parse(e.start.dateTime),
      endMs: Date.parse(e.end?.dateTime || e.start.dateTime),
      summary: e.summary,
    });
  }

  const workHabits = primary.filter((e) => /^MC\s*🔁/i.test(e.summary || ''));
  const workTasks = primary.filter((e) => /^P\d\s*·\s*MC-/i.test(e.summary || ''));

  let fixed = 0;
  for (const hEvt of workHabits) {
    const h0 = Date.parse(hEvt.start.dateTime);
    const h1 = Date.parse(hEvt.end?.dateTime || hEvt.start.dateTime);
    const bare = String(hEvt.summary || '').replace(/^MC\s*[^\s]+\s+/, '').trim();
    const habit = habitByTitle.get(bare.toLowerCase());
    const hPri = habit?.priority || 'p2';

    const clash = workTasks.find((t) => {
      const t0 = Date.parse(t.start.dateTime);
      const t1 = Date.parse(t.end?.dateTime || t.start.dateTime);
      return overlaps(h0, h1, t0, t1);
    });
    if (!clash) continue;

    const tm = /^P(\d)/i.exec(clash.summary || '');
    const tPri = tm ? `p${tm[1]}` : 'p3';
    // If task outranks or ties habit → move habit. Else leave (task should bump — do habit move anyway to clear stack).
    const moveHabit = priorityRank(hPri) >= priorityRank(tPri);
    if (!moveHabit) {
      console.log('SKIP (habit outranks task — need task bump)', bare.slice(0, 40), '×', clash.summary.slice(0, 40));
      // Still move habit to clear visible stack this cycle
    }

    const dur = Math.max(15, Math.round((h1 - h0) / 60000));
    const day0 = isoToLondonDate(hEvt.start.dateTime);
    const dayUsed = {};
    let slot = null;
    // Search forward up to 14 days
    for (let i = 0; i < 14; i += 1) {
      const day = addDays(day0, i);
      if (dayBlockedForHabits(day, blocked)) continue;
      const busySans = busy.filter((b) => !(b.startMs === h0 && b.endMs === h1));
      const trial = trySlotOnDay(
        day, dur, habit?.ideal_time || '10:00', bare, busySans, [], dayUsed, ruleMap,
      );
      if (!trial) continue;
      // Must not overlap any task
      const tHit = workTasks.some((t) => {
        const t0 = Date.parse(t.start.dateTime);
        const t1 = Date.parse(t.end?.dateTime || t.start.dateTime);
        return overlaps(Date.parse(trial.startIso), Date.parse(trial.endIso), t0, t1);
      });
      if (tHit) continue;
      slot = trial;
      break;
    }
    if (!slot) {
      console.log('NO SLOT', day0, bare.slice(0, 50));
      continue;
    }
    console.log('MOVE', bare.slice(0, 45), day0, '->', slot.day, slot.startIso.slice(11, 16));
    if (!APPLY) continue;
    await patchPrimaryEvent(hEvt.id, { startIso: slot.startIso, endIso: slot.endIso });
    // Update recurring_log if linked
    const logs = await sb(
      `recurring_log?calendar_event_id=eq.${encodeURIComponent(hEvt.id)}`
      + '&select=id&limit=1',
    );
    if (logs?.[0]?.id) {
      await sb(`recurring_log?id=eq.${logs[0].id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: {
          scheduled_date: slot.day,
          change: `diary_pin:${slot.startIso}|${slot.endIso}`,
        },
      });
    }
    busy.push({
      startMs: Date.parse(slot.startIso),
      endMs: Date.parse(slot.endIso),
      summary: bare,
    });
    fixed += 1;
  }
  console.log(JSON.stringify({ apply: APPLY, fixed }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
