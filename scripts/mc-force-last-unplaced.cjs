/**
 * Force-place the last stubborn unplaced ideals (wider window).
 * node scripts/mc-force-last-unplaced.cjs --apply
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const APPLY = process.argv.includes('--apply');
const TARGETS = [
  { titleRe: /Hotel bookings check \(Claude\)/i, ideal: '2026-12-30' },
  { titleRe: /Hotel bookings — Alan actions/i, ideal: '2026-12-30' },
  { titleRe: /Send Out Joining Details/i, ideal: '2027-01-01' },
  { titleRe: /BAU global refresh — Day 1/i, ideal: '2026-09-21' },
  { titleRe: /BAU global refresh — Day 2/i, ideal: '2026-09-22' },
  { titleRe: /BAU global refresh — Day 2/i, ideal: '2026-07-28' },
];

const { sb } = require('../api/mc/_lib');
const { fetchHorizonEvents } = require('../api/mc/gcal-lib');
const { insertPrimaryEvent } = require('../api/mc/gcal-write-lib');
const { habitGcalTitle } = require('../api/mc/gcal-title-lib');
const {
  awaySpansFromTravelBlocks, restDaySpansFromDbRows, restDaySpansFromWorkshopEvents,
  teachingDaySpansFromEvents, buildBusyIntervals, trySlotOnDay, dayBlockedForHabits,
  candidateDays,
} = require('../api/mc/habit-placer-lib');
const { ruleMapFromRows, bankHolidaySet, addDays, isoToLondonDate } = require('../api/mc/scheduling-rules-lib');
const { londonToday } = require('../api/mc/diary-lib');

(async () => {
  const today = londonToday();
  const toYmd = addDays(today, 220);
  const rules = await sb('scheduling_rules?select=key,value');
  const ruleMap = ruleMapFromRows(rules || []);
  const holidays = bankHolidaySet(ruleMap);
  const habits = await sb('recurring_tasks?select=*&active=eq.true');
  const { events } = await fetchHorizonEvents(`${today}T00:00:00.000Z`, `${toYmd}T23:59:59.000Z`);
  const travel = await sb(`travel_blocks?select=*&block_type=in.(travel_out,travel_back)&starts_at=gte.${today}T00:00:00Z&starts_at=lte.${toYmd}T23:59:59Z`);
  const restDb = await sb(`rest_day_blocks?status=eq.active&rest_date=gte.${today}&rest_date=lte.${toYmd}&select=rest_date,workshop_title`);
  const blocked = awaySpansFromTravelBlocks(travel || [])
    .concat(teachingDaySpansFromEvents(events || [], ruleMap))
    .concat(restDaySpansFromWorkshopEvents(events || [], ruleMap))
    .concat(restDaySpansFromDbRows(restDb || []));
  const busy = buildBusyIntervals(events || [], ruleMap).concat(blocked);
  for (const e of events || []) {
    if ((e._calendarId || 'primary') !== 'primary' || !e.start?.dateTime) continue;
    if (!/^MC\s*🔁/i.test(e.summary || '')) continue;
    busy.push({
      startMs: Date.parse(e.start.dateTime),
      endMs: Date.parse(e.end?.dateTime || e.start.dateTime),
      summary: e.summary,
    });
  }
  const dayUsed = {};
  const results = [];

  for (const t of TARGETS) {
    const habit = (habits || []).find((h) => t.titleRe.test(h.title));
    if (!habit) {
      results.push({ ...t, ok: false, reason: 'no_habit' });
      continue;
    }
    const logs = await sb(
      `recurring_log?recurring_task_id=eq.${habit.id}&ideal_date=eq.${t.ideal}`
      + '&select=id,scheduled_date,calendar_event_id,change&order=at.desc&limit=3',
    );
    if (logs?.[0]?.calendar_event_id) {
      results.push({ title: habit.title, ideal: t.ideal, ok: true, reason: 'already_gcal' });
      continue;
    }
    const startSearch = t.ideal < today ? today : t.ideal;
    const days = candidateDays(
      startSearch, 14, false, ruleMap, holidays, blocked, habit.rrule, true,
    ).filter((d) => d >= today);
    // Also allow bank-holiday adjacent: raw walk ±14 if candidateDays empty
    const more = [];
    for (let i = 0; i <= 14; i += 1) {
      more.push(addDays(startSearch, i));
      if (i) more.push(addDays(startSearch, -i));
    }
    const tryDays = [...new Set(days.concat(more))].filter((d) => d >= today).sort();
    let slot = null;
    for (const day of tryDays) {
      if (dayBlockedForHabits(day, blocked)) continue;
      // Soft: allow bank holidays for joining details / hotel only if still blocked-empty
      const trial = trySlotOnDay(
        day, Number(habit.duration_min) || 60, habit.ideal_time || '10:00',
        habit.title, busy, [], dayUsed, ruleMap,
      );
      if (trial) { slot = trial; break; }
    }
    if (!slot) {
      results.push({ title: habit.title, ideal: t.ideal, ok: false, reason: 'no_slot' });
      continue;
    }
    console.log('place', habit.title, t.ideal, '->', slot.day, slot.startIso);
    if (APPLY) {
      const title = habitGcalTitle(habit.title, { habit: ruleMap.title_prefix_recurring || 'MC 🔁' });
      const evt = await insertPrimaryEvent({
        summary: title,
        description: `Mission Control habit — ${habit.title}`,
        startIso: slot.startIso,
        endIso: slot.endIso,
      });
      const body = {
        scheduled_date: slot.day,
        calendar_event_id: evt.id,
        change: `diary_pin:${slot.startIso}|${slot.endIso}`,
      };
      if (logs?.[0]?.id) {
        await sb(`recurring_log?id=eq.${logs[0].id}`, { method: 'PATCH', prefer: 'return=minimal', body });
      } else {
        await sb('recurring_log', {
          method: 'POST', prefer: 'return=minimal',
          body: {
            recurring_task_id: habit.id, ideal_date: t.ideal, actor: 'cursor', ...body,
          },
        });
      }
      busy.push({
        startMs: Date.parse(slot.startIso),
        endMs: Date.parse(slot.endIso),
        summary: habit.title,
      });
      dayUsed[slot.day] = (dayUsed[slot.day] || 0) + (slot.durationMin || 60);
      results.push({ title: habit.title, ideal: t.ideal, day: slot.day, ok: true, id: evt.id });
    } else {
      results.push({ title: habit.title, ideal: t.ideal, day: slot.day, ok: true, dry: true });
    }
  }
  console.log(JSON.stringify(results, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
