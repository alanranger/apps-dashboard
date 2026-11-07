const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '..', '.env.local');
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { sb } = require('../api/mc/_lib');
const {
  placeHabits, awaySpansFromTravelBlocks, restDaySpansFromDbRows, buildAmendments,
} = require('../api/mc/habit-placer-lib');
const { ruleMapFromRows, bankHolidaySet } = require('../api/mc/scheduling-rules-lib');
const { londonToday, parseDiaryPin, isSkippedChange } = require('../api/mc/diary-lib');

(async () => {
  const today = londonToday();
  const rules = await sb('scheduling_rules?select=key,value');
  const ruleMap = ruleMapFromRows(rules || []);
  const holidays = bankHolidaySet(ruleMap);
  const habits = await sb('recurring_tasks?select=id,title,priority,duration_min,ideal_time,window_days,time_critical,rrule&active=eq.true');
  const deps = await sb('recurring_task_deps?select=habit_id,depends_on_habit_id,dep_type,within_hours');
  const rest = await sb(`rest_day_blocks?status=eq.active&rest_date=gte.${today}&rest_date=lte.2027-01-31&select=rest_date,workshop_title`);
  const travel = await sb(`travel_blocks?select=*&block_type=in.(travel_out,travel_back)&starts_at=gte.${today}T00:00:00Z&starts_at=lte.2027-01-31T23:59:59Z`);
  const busy = awaySpansFromTravelBlocks(travel || []).concat(restDaySpansFromDbRows(rest || []));
  const { placements, unplaced } = placeHabits(
    habits || [], deps || [], busy, ruleMap, holidays, today, '2027-01-31', {},
  );
  const idBau = 'b002933c-0068-4dca-8661-f4098ccd714d';
  const idBlog = '2d5898bd-fa64-42d7-9649-d16fa771e945';
  console.log('BAU D1 placements', placements.filter((p) => p.habit_id === idBau));
  console.log('Blog early', placements.filter((p) => p.habit_id === idBlog && p.day < '2026-09-01'));
  const logs = await sb('recurring_log?select=id,recurring_task_id,ideal_date,scheduled_date,calendar_event_id,change,at&scheduled_date=eq.2026-07-28&order=at.desc');
  const existing = [];
  for (const l of logs || []) {
    if (isSkippedChange(l.change) || /^unplaced/i.test(l.change || '')) continue;
    const h = (habits || []).find((x) => x.id === l.recurring_task_id);
    const pin = parseDiaryPin(l.change);
    console.log('DB Jul28', h?.title, 'ideal', l.ideal_date, pin);
    if (!l.calendar_event_id || !l.ideal_date || !pin || !h) continue;
    existing.push({
      habit_id: l.recurring_task_id, title: h.title, ideal_date: l.ideal_date,
      startIso: pin.start, endIso: pin.end, calendar_event_id: l.calendar_event_id,
    });
  }
  const am = buildAmendments(placements, existing, today);
  console.log('amendments', am);
  console.log('unplaced bau/blog', unplaced.filter((u) => u.habit_id === idBau || u.habit_id === idBlog));
})().catch((e) => { console.error(e); process.exit(1); });
