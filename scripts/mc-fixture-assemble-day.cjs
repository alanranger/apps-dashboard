const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { sb } = require('../api/mc/_lib');
const { fetchHorizonEvents } = require('../api/mc/gcal-lib');
const {
  londonToday, addDaysYmd, mondayOnOrBefore, ruleMapFromRows, splitMcAndBusy,
  tasksToBlocks, travelToBlocks, busyToBlocks, habitLogsToBlocks,
  insertDecompressStrips, indexGcalEventsById, applyGcalBaselineTimes,
  untiedMcBlocks, hotelDeadlineBlocks, fixtureFlanksToBlocks,
} = require('../api/mc/diary-lib');

(async () => {
  const from = '2026-08-20';
  const to = '2026-08-23';
  const timeMin = `${from}T00:00:00.000Z`;
  const timeMax = `2026-08-24T00:00:00.000Z`;
  const rules = await sb('scheduling_rules?select=key,value');
  const ruleMap = ruleMapFromRows(rules);
  const [tasks, travel, habits, logs, hotels, fixtureRows] = await Promise.all([
    sb(`tasks?select=id,display_id,title,state,priority,completed_on,last_activity_at,scheduled_start,scheduled_end,slot_pinned,calendar_event_id,est_minutes,actual_minutes&scheduled_start=gte.${timeMin}&scheduled_start=lt.${timeMax}`),
    sb(`travel_blocks?select=*&starts_at=gte.${timeMin}&starts_at=lt.${timeMax}`),
    sb('recurring_tasks?select=id,title,duration_min,ideal_time,priority,active,last_done&active=eq.true'),
    sb(`recurring_log?select=id,recurring_task_id,ideal_date,scheduled_date,calendar_event_id,change,at&scheduled_date=gte.${from}&scheduled_date=lte.${to}`),
    sb('workshop_hotels?select=id,hotel,reminder_event_id,status&reminder_event_id=not.is.null&status=eq.active'),
    sb(`fixture_blocks?select=id,fixture_event_id,title,fixture_start,fixture_end,block_start,block_end,buffer_min,before_event_id,after_event_id,status&status=eq.active&fixture_start=gte.${timeMin}&fixture_start=lt.${timeMax}`),
  ]);
  const habitMap = new Map((habits || []).map((h) => [h.id, h]));
  const hotelByEventId = new Map();
  const { events } = await fetchHorizonEvents(timeMin, timeMax);
  const split = splitMcAndBusy(events, ruleMap);
  const eventById = indexGcalEventsById([...(split.mc || []), ...(split.busy || []), ...(split.fixtures || [])]);
  const tiedIds = new Set([
    ...(tasks || []).map((t) => t.calendar_event_id).filter(Boolean),
    ...(logs || []).map((l) => l.calendar_event_id).filter(Boolean),
    ...(travel || []).map((t) => t.calendar_event_id).filter(Boolean),
  ]);
  const busyEvents = (split.busy || []).filter((e) => !e?.id || !tiedIds.has(e.id));
  const fixtures = (split.fixtures || []).filter((e) => !e?.id || !tiedIds.has(e.id));
  console.log('hard_fixture in busy', busyEvents.filter((e) => e.hard_fixture).map((e) => e.summary));
  const busyBlocks = busyToBlocks(busyEvents, fixtures);
  const dbBlocks = [
    ...tasksToBlocks(tasks, londonToday()),
    ...habitLogsToBlocks(logs, habitMap),
    ...travelToBlocks(travel),
    ...busyBlocks,
    ...fixtureFlanksToBlocks(fixtureRows),
  ];
  const { blocks: baselined } = applyGcalBaselineTimes(dbBlocks, eventById);
  const orphans = untiedMcBlocks(split.mc || [], tiedIds);
  const blocks = insertDecompressStrips([...baselined, ...orphans], ruleMap)
    .filter((b) => b.day === '2026-08-22' && /ipswich|sunderland|⚽/i.test(b.title || ''));
  for (const b of blocks) {
    console.log(`${b.start_min}-${b.end_min} [${b.kind}] ${b.title} id=${b.id} evt=${b.calendar_event_id}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
