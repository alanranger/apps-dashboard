/**
 * Place hotel/room deadline reminders before cancel-by date,
 * never on away / teaching / rest days — walk earlier until actionable.
 */
const { addDays, isoToLondonDate, workingWindow } = require('./scheduling-rules-lib');
const {
  awaySpansFromTravelBlocks, teachingDaySpansFromEvents,
  restDaySpansFromWorkshopEvents, dayBlockedForHabits, londonYmdHmToUtcMs,
} = require('./habit-placer-lib');
const { hotelReminderLeadDays } = require('./travel-coverage-lib');

function isDeadlineReminderTitle(summary) {
  const t = String(summary || '');
  return /MC\s*⏰/i.test(t) && /Hotel deadline|Hotel decision|Room release|cancel by/i.test(t);
}

function blockedSpans(events, travelBlocks, restDb, ruleMap) {
  return awaySpansFromTravelBlocks(travelBlocks || [])
    .concat(teachingDaySpansFromEvents(events || [], ruleMap))
    .concat(restDaySpansFromWorkshopEvents(events || [], ruleMap))
    .concat((restDb || []).map((r) => ({
      startDay: r.rest_date,
      endDay: r.rest_date,
      restDay: r.rest_date,
      kind: 'rest_after_workshop',
    })));
}

/**
 * Ideal remind day = cancelDay - lead; walk earlier while blocked.
 * Must stay strictly before cancelDay.
 */
function actionableRemindDay(cancelDay, leadDays, spans, todayYmd) {
  const lead = Math.max(1, Number(leadDays) || 3);
  const cancel = String(cancelDay).slice(0, 10);
  let day = addDays(cancel, -lead);
  // Allow walking earlier than the ideal lead day when that day is blocked.
  const walkBackLimit = addDays(cancel, -Math.max(lead + 21, 42));
  const floor = todayYmd && todayYmd > walkBackLimit ? todayYmd : walkBackLimit;
  while (day >= floor) {
    if (day < cancel && !dayBlockedForHabits(day, spans)) return day;
    day = addDays(day, -1);
  }
  const eve = addDays(cancel, -1);
  if (eve >= floor && !dayBlockedForHabits(eve, spans)) return eve;
  return null;
}

function reminderWindowIso(day, ruleMap, durationMin = 20, events = []) {
  const { isoToLondonMinutes } = require('./scheduling-rules-lib');
  const win = workingWindow(ruleMap, day);
  const startBound = win?.start_min ?? 9 * 60;
  const endBound = win?.end_min ?? 18 * 60;
  const dur = Math.max(15, durationMin);
  const dayBusy = [];
  for (const e of events || []) {
    if (!e.start?.dateTime) continue;
    if (isoToLondonDate(e.start.dateTime) !== day) continue;
    if (e.transparency === 'transparent') continue;
    const s = isoToLondonMinutes(e.start.dateTime);
    const en = isoToLondonMinutes(e.end?.dateTime || e.start.dateTime);
    dayBusy.push({ s, e: en });
  }
  function free(t0, t1) {
    return !dayBusy.some((b) => t0 < b.e && b.s < t1);
  }
  let startMin = null;
  for (let t = startBound; t + dur <= endBound; t += 15) {
    if (free(t, t + dur)) {
      startMin = t;
      break;
    }
  }
  if (startMin == null) return null;
  const endMin = startMin + dur;
  const pad = (n) => String(n).padStart(2, '0');
  const startHm = `${pad(Math.floor(startMin / 60))}:${pad(startMin % 60)}`;
  const endHm = `${pad(Math.floor(endMin / 60))}:${pad(endMin % 60)}`;
  return {
    startIso: new Date(londonYmdHmToUtcMs(day, startHm)).toISOString(),
    endIso: new Date(londonYmdHmToUtcMs(day, endHm)).toISOString(),
    day,
  };
}

function planHotelDeadlinePlacement(hotel, {
  events = [], travelBlocks = [], restDb = [], ruleMap = {}, todayYmd,
} = {}) {
  if (!hotel?.free_cancel_until) return null;
  const cancelDay = String(hotel.free_cancel_until).slice(0, 10);
  const lead = hotelReminderLeadDays(hotel, Number(ruleMap.hotel_deadline_reminder_days || 3));
  const spans = blockedSpans(events, travelBlocks, restDb, ruleMap);
  let day = actionableRemindDay(cancelDay, lead, spans, todayYmd);
  let slot = null;
  while (day && day < cancelDay) {
    slot = reminderWindowIso(day, ruleMap, 20, events);
    if (slot) break;
    day = require('./scheduling-rules-lib').addDays(day, -1);
    if (dayBlockedForHabits(day, spans)) continue;
  }
  if (!day || !slot || day >= cancelDay) return null;
  return {
    hotel_id: hotel.id,
    cancel_day: cancelDay,
    remind_day: day,
    lead_days: lead,
    ...slot,
  };
}

function parseCancelDayFromTitle(summary) {
  const t = String(summary || '');
  const iso = /(\d{4}-\d{2}-\d{2})/.exec(t);
  if (iso) return iso[1];
  // cancel by 5 Sep / 5 September / 7-8 Jan
  const m = /cancel by\s+(\d{1,2})(?:-\d{1,2})?\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*/i.exec(t);
  if (!m) return null;
  const months = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
  };
  const mon = months[m[2].slice(0, 3).toLowerCase()];
  if (!mon) return null;
  const day = String(m[1]).padStart(2, '0');
  // Infer year from context: prefer year mentioned elsewhere, else from "2026" in title, else current+lookahead
  const y = /20\d{2}/.exec(t);
  let year = y ? y[0] : String(new Date().getFullYear());
  // If month is Jan-Jun and we're in Jul+, might be next year — caller can pass today
  return `${year}-${mon}-${day}`;
}

/**
 * Re-time an existing live reminder event using cancel-by from title / map.
 */
function planReminderRetimes(events, {
  travelBlocks = [], restDb = [], ruleMap = {}, todayYmd, cancelDayByEventId = {},
} = {}) {
  const spans = blockedSpans(events, travelBlocks, restDb, ruleMap);
  const leadDefault = Number(ruleMap.hotel_deadline_reminder_days || 3);
  const out = [];
  for (const e of events || []) {
    if ((e._calendarId || 'primary') !== 'primary') continue;
    if (!e.start?.dateTime || !isDeadlineReminderTitle(e.summary)) continue;
    let cancelDay = cancelDayByEventId[e.id] || parseCancelDayFromTitle(e.summary);
    if (!cancelDay) continue;
    // Fix year if parsed date is before today by >60 days into past relative to event
    if (todayYmd && cancelDay < todayYmd) {
      const nextY = String(Number(cancelDay.slice(0, 4)) + 1);
      cancelDay = `${nextY}${cancelDay.slice(4)}`;
    }
    const liveDay = isoToLondonDate(e.start.dateTime);
    const day = actionableRemindDay(cancelDay, leadDefault, spans, todayYmd);
    if (!day || day >= cancelDay) continue;
    const others = (events || []).filter((x) => x.id !== e.id);
    let tryDay = day;
    let slot = null;
    while (tryDay && tryDay < cancelDay) {
      if (!dayBlockedForHabits(tryDay, spans)) {
        slot = reminderWindowIso(tryDay, ruleMap, 20, others);
        if (slot) break;
      }
      tryDay = addDays(tryDay, -1);
    }
    if (!slot) continue;
    const same = liveDay === slot.day
      && Math.abs(Date.parse(e.start.dateTime) - Date.parse(slot.startIso)) <= 2 * 60000;
    if (same) continue;
    out.push({
      event_id: e.id,
      summary: e.summary,
      from_day: liveDay,
      to_day: slot.day,
      cancel_day: cancelDay,
      startIso: slot.startIso,
      endIso: slot.endIso,
      reason: dayBlockedForHabits(liveDay, spans) ? 'was_on_blocked_day' : 'bring_forward_before_due',
    });
  }
  return out;
}

module.exports = {
  isDeadlineReminderTitle,
  actionableRemindDay,
  reminderWindowIso,
  planHotelDeadlinePlacement,
  planReminderRetimes,
  parseCancelDayFromTitle,
  hotelReminderLeadDays,
};
