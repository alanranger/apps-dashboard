/**
 * Dry diagnose LL with full busy map (same as placer).
 * node scripts/mc-diagnose-ll.cjs
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const LL_ID = 'c2f135c9-7146-415d-8231-c2460a064e94';
const { sb } = require('../api/mc/_lib');
const { fetchHorizonEvents } = require('../api/mc/gcal-lib');
const {
  placeHabits, awaySpansFromTravelBlocks, restDaySpansFromDbRows,
  restDaySpansFromWorkshopEvents, teachingDaySpansFromEvents, buildBusyIntervals,
  dayCapLimits, candidateDays, dayBlockedForHabits,
} = require('../api/mc/habit-placer-lib');
const { ruleMapFromRows, bankHolidaySet, addDays } = require('../api/mc/scheduling-rules-lib');
const { londonToday } = require('../api/mc/diary-lib');

(async () => {
  const today = londonToday();
  const toYmd = addDays(today, 200);
  const rules = await sb('scheduling_rules?select=key,value');
  const ruleMap = ruleMapFromRows(rules || []);
  const holidays = bankHolidaySet(ruleMap);
  console.log('dayCap', dayCapLimits(ruleMap));
  const { events } = await fetchHorizonEvents(`${addDays(today, -14)}T00:00:00.000Z`, `${toYmd}T23:59:59.000Z`);
  const [habits, deps, travel, restDb] = await Promise.all([
    sb('recurring_tasks?select=id,title,priority,duration_min,ideal_time,window_days,time_critical,rrule,last_done,rolls_used&active=eq.true'),
    sb('recurring_task_deps?select=habit_id,depends_on_habit_id,dep_type,within_hours'),
    sb(`travel_blocks?select=*&block_type=in.(travel_out,travel_back)&starts_at=gte.${today}T00:00:00Z&starts_at=lte.${toYmd}T23:59:59Z`),
    sb(`rest_day_blocks?status=eq.active&rest_date=gte.${today}&rest_date=lte.${toYmd}&select=rest_date,workshop_title`),
  ]);
  const ll = (habits || []).find((h) => h.id === LL_ID);
  const away = awaySpansFromTravelBlocks(travel || []);
  const teaching = teachingDaySpansFromEvents(events || [], ruleMap);
  const rest = restDaySpansFromWorkshopEvents(events || [], ruleMap)
    .concat(restDaySpansFromDbRows(restDb || []));
  const clientBusy = buildBusyIntervals(events || [], ruleMap);
  const blockedSpans = away.concat(teaching).concat(rest);
  const hardBusy = clientBusy.concat(blockedSpans);

  const ideals = ['2026-08-15', '2026-09-15', '2026-10-15', '2026-11-15', '2026-12-15'];
  for (const ideal of ideals) {
    const days = candidateDays(
      ideal, ll.window_days, ll.time_critical === true, ruleMap, holidays, blockedSpans,
      ll.rrule, true,
    );
    const blocked = days.map((d) => ({
      d,
      blocked: dayBlockedForHabits(d, blockedSpans),
      teach: teaching.some((s) => d >= (s.startDay || '') && d <= (s.endDay || s.restDay || '')),
      away: away.some((s) => d >= (s.startDay || '') && d <= (s.endDay || '')),
    }));
    console.log('\nideal', ideal, 'candidates', days);
    console.log('  detail', blocked);
  }

  const { placements, unplaced } = placeHabits(
    habits || [], deps || [], hardBusy.slice(), ruleMap, holidays, today, toYmd, {},
  );
  console.log('\nLL placements', placements.filter((p) => p.habit_id === LL_ID));
  console.log('LL unplaced', unplaced.filter((u) => u.habit_id === LL_ID));
  console.log('unplaced sample', unplaced.filter((u) => u.habit_id === LL_ID || /newsletter/i.test(u.title || '')));
})().catch((e) => { console.error(e); process.exit(1); });
