/**
 * Place ONLY Light & Logic occurrences (no full placer thrash).
 * node scripts/mc-place-light-logic.cjs --apply
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

if (!process.argv.includes('--apply')) {
  console.log('Pass --apply to write. Dry: node scripts/mc-diagnose-ll.cjs');
  process.exit(0);
}

const LL_ID = 'c2f135c9-7146-415d-8231-c2460a064e94';
const { sb } = require('../api/mc/_lib');
const { fetchHorizonEvents } = require('../api/mc/gcal-lib');
const { insertPrimaryEvent, deletePrimaryEvent } = require('../api/mc/gcal-write-lib');
const { habitGcalTitle } = require('../api/mc/gcal-title-lib');
const {
  placeHabits, awaySpansFromTravelBlocks, restDaySpansFromDbRows,
  restDaySpansFromWorkshopEvents, teachingDaySpansFromEvents, buildBusyIntervals,
} = require('../api/mc/habit-placer-lib');
const { ruleMapFromRows, bankHolidaySet, addDays } = require('../api/mc/scheduling-rules-lib');
const { londonToday } = require('../api/mc/diary-lib');
const { isoToLondonDate } = require('../api/mc/scheduling-rules-lib');

(async () => {
  const today = londonToday();
  const toYmd = addDays(today, 200);
  const rules = await sb('scheduling_rules?select=key,value');
  const ruleMap = ruleMapFromRows(rules || []);
  const holidays = bankHolidaySet(ruleMap);
  const prefix = ruleMap.title_prefix_recurring || 'MC 🔁';

  const { events } = await fetchHorizonEvents(`${addDays(today, -14)}T00:00:00.000Z`, `${toYmd}T23:59:59.000Z`);
  const [habits, deps, travel, restDb, logs] = await Promise.all([
    sb('recurring_tasks?select=id,title,priority,duration_min,ideal_time,window_days,time_critical,rrule,last_done,rolls_used&active=eq.true'),
    sb('recurring_task_deps?select=habit_id,depends_on_habit_id,dep_type,within_hours'),
    sb(`travel_blocks?select=*&block_type=in.(travel_out,travel_back)&starts_at=gte.${today}T00:00:00Z&starts_at=lte.${toYmd}T23:59:59Z`),
    sb(`rest_day_blocks?status=eq.active&rest_date=gte.${today}&rest_date=lte.${toYmd}&select=rest_date,workshop_title`),
    sb(`recurring_log?recurring_task_id=eq.${LL_ID}&select=id,ideal_date,scheduled_date,calendar_event_id,change&order=ideal_date.asc`),
  ]);

  const blocked = awaySpansFromTravelBlocks(travel || [])
    .concat(teachingDaySpansFromEvents(events || [], ruleMap))
    .concat(restDaySpansFromWorkshopEvents(events || [], ruleMap))
    .concat(restDaySpansFromDbRows(restDb || []));
  const hardBusy = buildBusyIntervals(events || [], ruleMap).concat(blocked);

  // Seed existing habit busy from GCal so trySlot doesn't collide.
  for (const e of events || []) {
    if ((e._calendarId || 'primary') !== 'primary' || !e.start?.dateTime) continue;
    if (!/^MC\s*🔁/i.test(e.summary || '')) continue;
    hardBusy.push({
      startMs: Date.parse(e.start.dateTime),
      endMs: Date.parse(e.end?.dateTime || e.start.dateTime),
      summary: e.summary,
    });
  }

  const { placements, unplaced } = placeHabits(
    habits || [], deps || [], hardBusy.slice(), ruleMap, holidays, today, toYmd, {},
  );
  const llPlace = placements.filter((p) => p.habit_id === LL_ID);
  console.log('planned', llPlace.map((p) => `${p.ideal_date}->${p.day} ${p.startIso}`));
  console.log('unplaced', unplaced.filter((u) => u.habit_id === LL_ID));

  const logByIdeal = new Map((logs || []).map((r) => [r.ideal_date, r]));
  const title = habitGcalTitle('Light & Logic newsletter issue', { habit: prefix });
  let created = 0;
  let kept = 0;

  for (const p of llPlace) {
    const row = logByIdeal.get(p.ideal_date);
    if (row?.calendar_event_id) {
      // Already live — keep Jan pin etc.
      kept += 1;
      console.log('keep', p.ideal_date, row.calendar_event_id);
      continue;
    }
    // Drop any stale same-title orphan decompress already purged; create habit block.
    const createdEvt = await insertPrimaryEvent({
      summary: title,
      description: 'Mission Control habit — Light & Logic newsletter (4h).',
      startIso: p.startIso,
      endIso: p.endIso,
    });
    const eid = createdEvt?.id;
    if (!eid) {
      console.log('FAIL create', p.ideal_date, createdEvt);
      continue;
    }
    const change = `diary_pin:${p.startIso}|${p.endIso}`;
    if (row?.id) {
      await sb(`recurring_log?id=eq.${row.id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: {
          scheduled_date: p.day,
          calendar_event_id: eid,
          change,
        },
      });
    } else {
      await sb('recurring_log', {
        method: 'POST', prefer: 'return=minimal',
        body: {
          recurring_task_id: LL_ID,
          ideal_date: p.ideal_date,
          scheduled_date: p.day,
          calendar_event_id: eid,
          change,
        },
      });
    }
    created += 1;
    console.log('created', p.ideal_date, '->', p.day, eid);
  }

  await sb(`recurring_tasks?id=eq.${LL_ID}`, {
    method: 'PATCH', prefer: 'return=minimal',
    body: {
      last_scheduled: llPlace.map((p) => p.day).sort().slice(-1)[0] || null,
      updated_at: new Date().toISOString(),
    },
  });

  const livePack = await fetchHorizonEvents(`${today}T00:00:00.000Z`, `${toYmd}T23:59:59.000Z`);
  const live = (livePack.events || []).filter((e) => /Light\s*&\s*Logic|newsletter issue/i.test(e.summary || '') && e.start?.dateTime);
  console.log(JSON.stringify({ created, kept, live: live.length }, null, 2));
  for (const e of live.sort((a, b) => a.start.dateTime.localeCompare(b.start.dateTime))) {
    console.log(isoToLondonDate(e.start.dateTime), e.start.dateTime.slice(11, 16), e.summary);
  }
})().catch((e) => { console.error(e); process.exit(1); });
