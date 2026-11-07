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
  const from = '2026-08-22';
  const to = '2026-08-22';
  const timeMin = `${from}T00:00:00.000Z`;
  const timeMax = `2026-08-23T00:00:00.000Z`;
  const rules = await sb('scheduling_rules?select=key,value');
  const ruleMap = ruleMapFromRows(rules);
  const [tasks, travel, habits, logs, hotels, fixtureRows] = await Promise.all([
    sb(`tasks?select=id,display_id,title,state,priority,completed_on,last_activity_at,scheduled_start,scheduled_end,slot_pinned,calendar_event_id,est_minutes,actual_minutes&scheduled_start=gte.${timeMin}&scheduled_start=lt.${timeMax}`),
    sb(`travel_blocks?select=*&starts_at=gte.${timeMin}&starts_at=lt.${timeMax}`),
    sb('recurring_tasks?select=id,title,duration_min,ideal_time,priority,active,last_done&active=eq.true'),
    sb(`recurring_log?select=id,recurring_task_id,ideal_date,scheduled_date,calendar_event_id,change,at&scheduled_date=eq.${from}`),
    sb('workshop_hotels?select=id,hotel,reminder_event_id,status&reminder_event_id=not.is.null&status=eq.active'),
    sb(`fixture_blocks?select=*&status=eq.active&fixture_start=gte.${timeMin}&fixture_start=lt.${timeMax}`),
  ]);
  const habitMap = new Map((habits || []).map((h) => [h.id, h]));
  const hotelByEventId = new Map();
  const { events } = await fetchHorizonEvents(timeMin, timeMax);
  const split = splitMcAndBusy(events, ruleMap);
  console.log('split counts', {
    mc: (split.mc || []).length,
    busy: (split.busy || []).length,
    fixtures: (split.fixtures || []).length,
    mcTitles: (split.mc || []).map((e) => e.summary),
    fixTitles: (split.fixtures || []).map((e) => ({ s: e.summary, start: e.start, end: e.end, cal: e._calendarId })),
    busyFix: (split.busy || []).filter((e) => /ipswich|⚽/i.test(e.summary || '')).map((e) => ({ s: e.summary, cal: e._calendarId, start: e.start })),
  });
  const eventById = indexGcalEventsById([...(split.mc || []), ...(split.busy || [])]);
  const tiedIds = new Set([
    ...(tasks || []).map((t) => t.calendar_event_id).filter(Boolean),
    ...(logs || []).map((l) => l.calendar_event_id).filter(Boolean),
    ...(travel || []).map((t) => t.calendar_event_id).filter(Boolean),
  ]);
  const busyEvents = (split.busy || []).filter((e) => !e?.id || !tiedIds.has(e.id));
  const fixtures = (split.fixtures || []).filter((e) => !e?.id || !tiedIds.has(e.id));
  const layers = {
    busy: busyToBlocks(busyEvents, []),
    fixtures: busyToBlocks([], fixtures),
    flanks: fixtureFlanksToBlocks(fixtureRows),
    orphans: untiedMcBlocks(split.mc || [], tiedIds),
  };
  for (const [name, arr] of Object.entries(layers)) {
    const hits = arr.filter((b) => /ipswich|sunderland|⚽|pre-match|post-match/i.test(b.title || ''));
    console.log(`\nLAYER ${name} (${hits.length})`);
    for (const b of hits) {
      console.log(`  ${b.day} ${b.start_min}-${b.end_min} [${b.kind}] ${b.title} id=${b.id} orphan=${!!b.gcal_orphan}`);
    }
  }
  console.log('\nfixtureRows', fixtureRows);
})().catch((e) => { console.error(e); process.exit(1); });
