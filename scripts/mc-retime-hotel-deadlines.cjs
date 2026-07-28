/**
 * Bring hotel/room deadline reminders forward off away/workshop days,
 * into working-window slots before cancel-by.
 * node scripts/mc-retime-hotel-deadlines.cjs
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { sb } = require('../api/mc/_lib');
const { fetchHorizonEvents } = require('../api/mc/gcal-lib');
const { patchPrimaryEvent, verifyPrimaryEvent } = require('../api/mc/gcal-write-lib');
const { ruleMapFromRows } = require('../api/mc/scheduling-rules-lib');
const { londonToday, addDaysYmd } = require('../api/mc/diary-lib');
const {
  planReminderRetimes, planHotelDeadlinePlacement, isDeadlineReminderTitle,
} = require('../api/mc/hotel-deadline-place-lib');

async function main() {
  const today = londonToday();
  const [rules, hotels, travel, rest, gcal] = await Promise.all([
    sb('scheduling_rules?select=key,value'),
    sb('workshop_hotels?select=*&status=eq.active'),
    sb('travel_blocks?select=*&order=starts_at.asc'),
    sb('rest_day_blocks?select=rest_date,workshop_title'),
    fetchHorizonEvents(
      `${addDaysYmd(today, -14)}T00:00:00.000Z`,
      `${addDaysYmd(today, 400)}T00:00:00.000Z`,
    ),
  ]);
  const ruleMap = ruleMapFromRows(rules || []);
  const cancelDayByEventId = {};
  for (const h of hotels || []) {
    if (h.reminder_event_id && h.free_cancel_until) {
      cancelDayByEventId[h.reminder_event_id] = String(h.free_cancel_until).slice(0, 10);
    }
  }

  // Prefer DB hotel plans when we have reminder ids
  const plans = [];
  for (const h of hotels || []) {
    if (!h.reminder_event_id || !h.free_cancel_until) continue;
    const p = planHotelDeadlinePlacement(h, {
      events: (gcal.events || []).filter((e) => e.id !== h.reminder_event_id),
      travelBlocks: travel || [],
      restDb: rest || [],
      ruleMap,
      todayYmd: today,
    });
    if (!p) continue;
    plans.push({
      event_id: h.reminder_event_id,
      summary: h.hotel || h.workshop_name,
      from_day: null,
      to_day: p.remind_day,
      cancel_day: p.cancel_day,
      startIso: p.startIso,
      endIso: p.endIso,
      reason: 'hotel_row',
    });
  }

  const fromLive = planReminderRetimes(gcal.events || [], {
    travelBlocks: travel || [],
    restDb: rest || [],
    ruleMap,
    todayYmd: today,
    cancelDayByEventId,
  });

  // Merge: hotel_row wins; add live-only reminders not in hotel plans
  const byId = new Map(plans.map((p) => [p.event_id, p]));
  for (const p of fromLive) {
    if (!byId.has(p.event_id)) byId.set(p.event_id, p);
  }

  let applied = 0;
  // Apply sequentially so later reminders see earlier ones as busy
  const liveEvents = [...(gcal.events || [])];
  for (const p of byId.values()) {
    const live = liveEvents.find((e) => e.id === p.event_id);
    if (!live?.start?.dateTime) continue;
    // Recompute slot against current liveEvents (exclude self)
    const hotel = (hotels || []).find((h) => h.reminder_event_id === p.event_id);
    let startIso = p.startIso;
    let endIso = p.endIso;
    let toDay = p.to_day;
    if (hotel?.free_cancel_until) {
      const replanned = planHotelDeadlinePlacement(hotel, {
        events: liveEvents.filter((e) => e.id !== p.event_id),
        travelBlocks: travel || [],
        restDb: rest || [],
        ruleMap,
        todayYmd: today,
      });
      if (replanned) {
        startIso = replanned.startIso;
        endIso = replanned.endIso;
        toDay = replanned.remind_day;
      }
    }
    if (Math.abs(Date.parse(live.start.dateTime) - Date.parse(startIso)) <= 120000) continue;
    await patchPrimaryEvent(p.event_id, { startIso, endIso });
    const v = await verifyPrimaryEvent(p.event_id, { startIso, endIso });
    console.log(
      v.ok ? 'moved' : 'FAIL',
      (live.summary || p.summary || '').slice(0, 55),
      p.from_day || '?',
      '->',
      toDay,
      p.reason,
    );
    // Update local copy so next reminder avoids this slot
    live.start = { dateTime: startIso };
    live.end = { dateTime: endIso };
    applied += 1;
  }

  // Report any deadline reminders still on blocked days
  const still = (gcal.events || []).filter((e) => isDeadlineReminderTitle(e.summary));
  console.log(JSON.stringify({ planned: byId.size, applied, live_reminders: still.length }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
