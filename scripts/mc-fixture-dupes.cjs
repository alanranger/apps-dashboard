/**
 * Detect fixture flank duplicates in diary paint (DB + GCal orphans + pre/post).
 * node scripts/mc-fixture-dupes.cjs [weeks=4]
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { sb } = require('../api/mc/_lib');
const { fetchHorizonEvents, gcalConfigured } = require('../api/mc/gcal-lib');
const {
  londonToday, addDaysYmd, mondayOnOrBefore, ruleMapFromRows, splitMcAndBusy,
  tasksToBlocks, travelToBlocks, busyToBlocks, habitLogsToBlocks,
  insertDecompressStrips, indexGcalEventsById, applyGcalBaselineTimes,
  untiedMcBlocks, hotelDeadlineBlocks, fixtureFlanksToBlocks,
} = require('../api/mc/diary-lib');
const { isoToLondonDate, isoToLondonMinutes } = require('../api/mc/scheduling-rules-lib');

const WEEKS = Number(process.argv[2]) || 4;

function hm(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

(async () => {
  const today = londonToday();
  const from = mondayOnOrBefore(today);
  const to = addDaysYmd(from, WEEKS * 7 - 1);
  const timeMin = `${from}T00:00:00.000Z`;
  const timeMax = `${addDaysYmd(to, 1)}T00:00:00.000Z`;
  const rules = await sb('scheduling_rules?select=key,value');
  const ruleMap = ruleMapFromRows(rules);
  const [tasks, travel, habits, logs, hotels, fixtureRows] = await Promise.all([
    sb(`tasks?select=*&scheduled_start=gte.${timeMin}&scheduled_start=lt.${timeMax}`),
    sb(`travel_blocks?select=*&starts_at=gte.${timeMin}&starts_at=lt.${timeMax}`),
    sb('recurring_tasks?select=id,title,duration_min,ideal_time,priority,active,last_done&active=eq.true'),
    sb(`recurring_log?select=*&scheduled_date=gte.${from}&scheduled_date=lte.${to}`),
    sb('workshop_hotels?select=id,hotel,reminder_event_id,status&reminder_event_id=not.is.null&status=eq.active'),
    sb(`fixture_blocks?select=*&status=eq.active&fixture_start=gte.${timeMin}&fixture_start=lt.${timeMax}`),
  ]);
  const habitMap = new Map((habits || []).map((h) => [h.id, h]));
  const hotelByEventId = new Map((hotels || []).filter((h) => h.reminder_event_id).map((h) => [h.reminder_event_id, h]));
  const { events } = await fetchHorizonEvents(timeMin, timeMax);
  const split = splitMcAndBusy(events, ruleMap);
  const eventById = indexGcalEventsById([...(split.mc || []), ...(split.busy || [])]);
  const tiedIds = new Set([
    ...(tasks || []).map((t) => t.calendar_event_id).filter(Boolean),
    ...(logs || []).map((l) => l.calendar_event_id).filter(Boolean),
    ...(travel || []).map((t) => t.calendar_event_id).filter(Boolean),
    ...hotelByEventId.keys(),
  ]);
  const busyEvents = (split.busy || []).filter((e) => !e?.id || !tiedIds.has(e.id));
  const fixtures = (split.fixtures || []).filter((e) => !e?.id || !tiedIds.has(e.id));
  const dbBlocks = [
    ...tasksToBlocks(tasks, today),
    ...habitLogsToBlocks(logs, habitMap),
    ...travelToBlocks(travel),
    ...busyToBlocks(busyEvents, fixtures),
    ...fixtureFlanksToBlocks(fixtureRows),
  ];
  const { blocks: baselined, drift_count } = applyGcalBaselineTimes(dbBlocks, eventById);
  const deadlines = hotelDeadlineBlocks(split.mc || [], hotelByEventId);
  for (const d of deadlines) if (d.calendar_event_id) tiedIds.add(d.calendar_event_id);
  const orphans = untiedMcBlocks(split.mc || [], tiedIds);
  const blocks = insertDecompressStrips([...baselined, ...deadlines, ...orphans], ruleMap)
    .filter((b) => b.day >= from && b.day <= to);

  const fixtureish = blocks.filter((b) => /⚽|ipswich|pre-match|post-match|before:|after:/i.test(b.title || ''));
  const byDay = {};
  for (const b of fixtureish) {
    if (!byDay[b.day]) byDay[b.day] = [];
    byDay[b.day].push({
      title: b.title,
      when: `${hm(b.start_min)}–${hm(b.end_min)}`,
      kind: b.kind,
      orphan: !!b.gcal_orphan,
      event_id: b.calendar_event_id || null,
      id: b.id,
    });
  }

  const dupeDays = Object.entries(byDay)
    .map(([day, rows]) => ({ day, count: rows.length, rows }))
    .filter((d) => d.count >= 4)
    .sort((a, b) => a.day.localeCompare(b.day));

  const awaiting = blocks.filter((b) => b.awaiting_push || b.out_of_sync);
  const report = {
    range: { from, to, weeks: WEEKS },
    drift_count,
    fixture_dupe_days: dupeDays,
    awaiting_or_out_of_sync: awaiting.map((b) => ({
      day: b.day, title: b.title, when: `${hm(b.start_min)}–${hm(b.end_min)}`,
      awaiting_push: !!b.awaiting_push, out_of_sync: !!b.out_of_sync,
      gcal: b.gcal_start ? `${b.gcal_start}–${b.gcal_end}` : null,
    })),
  };
  const out = path.join(__dirname, '..', 'tmp', `mc-fixture-dupes-${from}.json`);
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    fixture_dupe_days: dupeDays.length,
    sample: dupeDays.slice(0, 5).map((d) => ({ day: d.day, count: d.count, titles: d.rows.map((r) => `${r.when} ${r.title}`) })),
    awaiting: report.awaiting_or_out_of_sync.length,
  }, null, 2));
  console.log('wrote', out);
})().catch((e) => { console.error(e); process.exit(1); });
