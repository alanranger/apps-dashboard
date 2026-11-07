/**
 * Clear ONLY truly stuck unplaced habits (no GCal / unplaced log).
 * Does not mass-MOVE already-pinned habits. Never deletes a live GCal
 * just because the placer couldn't re-fit it in a crowded second pass.
 *
 * node scripts/mc-clear-unplaced-backlog.cjs
 * node scripts/mc-clear-unplaced-backlog.cjs --apply
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
const { insertPrimaryEvent, patchPrimaryEvent } = require('../api/mc/gcal-write-lib');
const { habitGcalTitle } = require('../api/mc/gcal-title-lib');
const {
  placeHabits, awaySpansFromTravelBlocks, restDaySpansFromDbRows,
  restDaySpansFromWorkshopEvents, teachingDaySpansFromEvents, buildBusyIntervals,
  candidateDays, trySlotOnDay, dayBlockedForHabits,
} = require('../api/mc/habit-placer-lib');
const { ruleMapFromRows, bankHolidaySet, addDays, isoToLondonDate } = require('../api/mc/scheduling-rules-lib');
const { londonToday } = require('../api/mc/diary-lib');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function key(hid, ideal) {
  return `${hid}|${ideal}`;
}

function isStuckLog(r) {
  if (!r) return true;
  if (r.calendar_event_id) return false;
  if (!r.scheduled_date) return true;
  if (/^unplaced/i.test(r.change || '')) return true;
  if (/^skip/i.test(r.change || '')) return false;
  // scheduled but never got a Google id
  return true;
}

async function main() {
  const today = londonToday();
  const toYmd = addDays(today, 200);
  const rules = await sb('scheduling_rules?select=key,value');
  const ruleMap = ruleMapFromRows(rules || []);
  const holidays = bankHolidaySet(ruleMap);
  const prefix = ruleMap.title_prefix_recurring || 'MC 🔁';
  console.log('horizon', today, '→', toYmd, 'apply', APPLY);

  const { events } = await fetchHorizonEvents(
    `${addDays(today, -14)}T00:00:00.000Z`,
    `${toYmd}T23:59:59.000Z`,
  );
  const [habits, deps, travel, restDb, logs] = await Promise.all([
    sb('recurring_tasks?select=id,title,priority,duration_min,ideal_time,window_days,time_critical,rrule,last_done,rolls_used&active=eq.true'),
    sb('recurring_task_deps?select=habit_id,depends_on_habit_id,dep_type,within_hours'),
    sb(`travel_blocks?select=*&block_type=in.(travel_out,travel_back)&starts_at=gte.${today}T00:00:00Z&starts_at=lte.${toYmd}T23:59:59Z`),
    sb(`rest_day_blocks?status=eq.active&rest_date=gte.${today}&rest_date=lte.${toYmd}&select=rest_date,workshop_title`),
    sb(
      `recurring_log?ideal_date=gte.${today}&ideal_date=lte.${toYmd}`
      + '&select=id,recurring_task_id,ideal_date,scheduled_date,calendar_event_id,change,at'
      + '&order=at.desc&limit=8000',
    ),
  ]);

  const habitMap = new Map((habits || []).map((h) => [h.id, h]));
  const latestLog = new Map();
  for (const r of logs || []) {
    if (!r.recurring_task_id || !r.ideal_date) continue;
    const k = key(r.recurring_task_id, r.ideal_date);
    if (!latestLog.has(k)) latestLog.set(k, r);
  }

  const stuckIdeals = [];
  for (const [k, r] of latestLog) {
    if (!isStuckLog(r)) continue;
    const habit = habitMap.get(r.recurring_task_id);
    if (!habit) continue;
    stuckIdeals.push({
      habit_id: r.recurring_task_id,
      title: habit.title,
      ideal_date: r.ideal_date,
      log: r,
    });
  }
  // Also ideals with NO log row yet but habit has occurrence in range — covered by placeHabits below.
  console.log('stuck_log_rows', stuckIdeals.length);

  const blocked = awaySpansFromTravelBlocks(travel || [])
    .concat(teachingDaySpansFromEvents(events || [], ruleMap))
    .concat(restDaySpansFromWorkshopEvents(events || [], ruleMap))
    .concat(restDaySpansFromDbRows(restDb || []));
  const hardBusy = buildBusyIntervals(events || [], ruleMap).concat(blocked);
  const liveIds = new Set();
  for (const e of events || []) {
    if ((e._calendarId || 'primary') !== 'primary' || !e.start?.dateTime) continue;
    if (!/^MC\s*🔁/i.test(e.summary || '')) continue;
    liveIds.add(e.id);
    hardBusy.push({
      startMs: Date.parse(e.start.dateTime),
      endMs: Date.parse(e.end?.dateTime || e.start.dateTime),
      summary: e.summary,
    });
  }

  // Place ALL habits so busy packing is realistic, then only write stuck ones.
  const { placements, unplaced } = placeHabits(
    habits || [], deps || [], hardBusy.slice(), ruleMap, holidays, today, toYmd, {},
  );
  const placeByKey = new Map(placements.map((p) => [key(p.habit_id, p.ideal_date), p]));

  // Rescue stuck ideals that didn't get a placement, with wider window.
  const dayUsed = {};
  for (const p of placements) dayUsed[p.day] = (dayUsed[p.day] || 0) + (p.duration_min || 0);
  const busyWork = hardBusy.slice();
  for (const p of placements) {
    busyWork.push({
      startMs: Date.parse(p.startIso),
      endMs: Date.parse(p.endIso),
      summary: p.title,
      habit_id: p.habit_id,
      ideal_date: p.ideal_date,
    });
  }

  let rescued = 0;
  for (const s of stuckIdeals) {
    if (placeByKey.has(key(s.habit_id, s.ideal_date))) continue;
    const habit = habitMap.get(s.habit_id);
    const days = candidateDays(
      s.ideal_date, Math.max(Number(habit.window_days) || 0, 7), habit.time_critical === true,
      ruleMap, holidays, blocked, habit.rrule, true,
    );
    let slot = null;
    for (const day of days) {
      if (dayBlockedForHabits(day, blocked)) continue;
      const trial = trySlotOnDay(
        day, Number(habit.duration_min) || 60, habit.ideal_time || '09:00',
        habit.title, busyWork, placements, dayUsed, ruleMap,
      );
      if (trial) { slot = trial; break; }
    }
    if (!slot) continue;
    const row = {
      habit_id: habit.id,
      title: habit.title,
      ideal_date: s.ideal_date,
      day: slot.day,
      startIso: slot.startIso,
      endIso: slot.endIso,
      duration_min: slot.durationMin,
    };
    placeByKey.set(key(habit.id, s.ideal_date), row);
    placements.push(row);
    dayUsed[slot.day] = (dayUsed[slot.day] || 0) + slot.durationMin;
    busyWork.push({
      startMs: Date.parse(slot.startIso),
      endMs: Date.parse(slot.endIso),
      summary: habit.title,
      habit_id: habit.id,
      ideal_date: s.ideal_date,
    });
    rescued += 1;
  }
  console.log('placements', placements.length, 'unplaced_total', unplaced.length, 'rescued_stuck', rescued);

  let created = 0;
  let adopted = 0;
  let failed = 0;
  const still = [];
  const written = [];

  for (const s of stuckIdeals) {
    let p = placeByKey.get(key(s.habit_id, s.ideal_date));
    if (!p) {
      still.push({ title: s.title, ideal: s.ideal_date, reason: 'no_slot' });
      continue;
    }
    // Never write new blocks onto past days — re-slot forward if needed.
    if (p.day < today) {
      const habit = habitMap.get(s.habit_id);
      const days = candidateDays(
        today, 10, false, ruleMap, holidays, blocked, habit.rrule, true,
      ).filter((d) => d >= today);
      let slot = null;
      for (const day of days) {
        if (dayBlockedForHabits(day, blocked)) continue;
        const trial = trySlotOnDay(
          day, Number(habit.duration_min) || 60, habit.ideal_time || '09:00',
          habit.title, busyWork, placements, dayUsed, ruleMap,
        );
        if (trial) { slot = trial; break; }
      }
      if (!slot) {
        still.push({ title: s.title, ideal: s.ideal_date, reason: 'past_no_forward_slot' });
        continue;
      }
      p = {
        ...p,
        day: slot.day,
        startIso: slot.startIso,
        endIso: slot.endIso,
        duration_min: slot.durationMin,
      };
      placeByKey.set(key(s.habit_id, s.ideal_date), p);
      dayUsed[slot.day] = (dayUsed[slot.day] || 0) + slot.durationMin;
      busyWork.push({
        startMs: Date.parse(slot.startIso),
        endMs: Date.parse(slot.endIso),
        summary: habit.title,
        habit_id: habit.id,
        ideal_date: s.ideal_date,
      });
    }
    const title = habitGcalTitle(p.title, { habit: prefix });
    const body = {
      scheduled_date: p.day,
      change: `diary_pin:${p.startIso}|${p.endIso}`,
    };

    // Prefer adopt existing event id if log somehow has one that still lives
    if (s.log?.calendar_event_id && liveIds.has(s.log.calendar_event_id)) {
      if (APPLY) {
        await patchPrimaryEvent(s.log.calendar_event_id, {
          summary: title, startIso: p.startIso, endIso: p.endIso,
        });
        await sb(`recurring_log?id=eq.${s.log.id}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: { ...body, calendar_event_id: s.log.calendar_event_id },
        });
      }
      adopted += 1;
      written.push({ title: s.title, ideal: s.ideal_date, day: p.day, how: 'adopt' });
      continue;
    }

    if (!APPLY) {
      created += 1;
      written.push({ title: s.title, ideal: s.ideal_date, day: p.day, how: 'create' });
      continue;
    }

    try {
      const evt = await insertPrimaryEvent({
        summary: title,
        description: `Mission Control habit — ${p.title}`,
        startIso: p.startIso,
        endIso: p.endIso,
      });
      if (s.log?.id) {
        await sb(`recurring_log?id=eq.${s.log.id}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: { ...body, calendar_event_id: evt.id },
        });
      } else {
        await sb('recurring_log', {
          method: 'POST', prefer: 'return=minimal',
          body: {
            recurring_task_id: s.habit_id,
            ideal_date: s.ideal_date,
            actor: 'cursor',
            calendar_event_id: evt.id,
            ...body,
          },
        });
      }
      created += 1;
      written.push({ title: s.title, ideal: s.ideal_date, day: p.day, how: 'create', id: evt.id });
      await sleep(55);
    } catch (e) {
      failed += 1;
      still.push({ title: s.title, ideal: s.ideal_date, reason: e.message || 'create_fail' });
    }
  }

  // Honest unplaced marker for stuck that still have no slot (do not delete GCal)
  if (APPLY) {
    for (const s of still) {
      const log = latestLog.get(key(
        [...habitMap.values()].find((h) => h.title === s.title)?.id || '',
        s.ideal,
      ));
      // find by stuckIdeals
    }
    for (const s of stuckIdeals) {
      if (placeByKey.has(key(s.habit_id, s.ideal_date))) continue;
      if (s.log?.calendar_event_id) continue; // leave live alone
      if (!s.log?.id) continue;
      await sb(`recurring_log?id=eq.${s.log.id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: {
          scheduled_date: null,
          calendar_event_id: null,
          change: `unplaced ${s.ideal_date}|backlog_clear_no_slot`,
        },
      });
    }
  }

  const summary = {
    apply: APPLY,
    stuck_before: stuckIdeals.length,
    created,
    adopted,
    failed,
    still_unplaced: still.length,
    still,
    written_sample: written.slice(0, 30),
    written_total: written.length,
  };
  console.log(JSON.stringify(summary, null, 2));
  const out = path.join(__dirname, '..', 'tmp', 'mc-clear-unplaced-backlog-LATEST.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ ...summary, written }, null, 2));
  console.log('WROTE', out);
}

main().catch((e) => { console.error(e); process.exit(1); });
