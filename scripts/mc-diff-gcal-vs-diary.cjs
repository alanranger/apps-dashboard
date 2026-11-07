/**
 * Diff Mission Control diary blocks vs Google Calendar for N weeks.
 * node scripts/mc-diff-gcal-vs-diary.cjs [weeks=4]
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
  untiedMcBlocks, hotelDeadlineBlocks,
} = require('../api/mc/diary-lib');
const { isoToLondonDate, isoToLondonMinutes } = require('../api/mc/scheduling-rules-lib');

const WEEKS = Math.min(8, Math.max(1, Number(process.argv[2]) || 4));

function hm(iso) {
  if (!iso) return '?';
  const min = isoToLondonMinutes(iso);
  if (!Number.isFinite(min)) return String(iso).slice(11, 16);
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function keyFor(day, startMin, endMin, title) {
  const t = String(title || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 80);
  return `${day}|${startMin}|${endMin}|${t}`;
}

function normTitle(t) {
  return String(t || '')
    .replace(/^DONE\s*[·•\-–]\s*/i, '')
    .replace(/^P[0-3]\s*[·•\-–]\s*/i, '')
    .replace(/^MC\s+[^\s]+\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function softKey(day, startMin, title) {
  // 5-min bucket + bare title
  const bucket = Math.round(startMin / 5) * 5;
  return `${day}|${bucket}|${normTitle(title)}`;
}

(async () => {
  if (!gcalConfigured()) throw new Error('gcal not configured');
  const today = londonToday();
  const from = mondayOnOrBefore(today);
  const to = addDaysYmd(from, WEEKS * 7 - 1);
  const timeMin = `${from}T00:00:00.000Z`;
  const timeMax = `${addDaysYmd(to, 1)}T00:00:00.000Z`;

  const rules = await sb('scheduling_rules?select=key,value');
  const ruleMap = ruleMapFromRows(rules);

  const [tasks, travel, habits, logs, hotels] = await Promise.all([
    sb(`tasks?select=id,display_id,title,state,priority,due_date,completed_on,last_activity_at,scheduled_start,scheduled_end,slot_pinned,calendar_event_id,est_minutes,actual_minutes&scheduled_start=gte.${timeMin}&scheduled_start=lt.${timeMax}&order=scheduled_start.asc`),
    sb(`travel_blocks?select=*&starts_at=gte.${timeMin}&starts_at=lt.${timeMax}&order=starts_at.asc`),
    sb('recurring_tasks?select=id,title,duration_min,ideal_time,priority,active,last_done&active=eq.true'),
    sb(`recurring_log?select=id,recurring_task_id,ideal_date,scheduled_date,calendar_event_id,change,at&scheduled_date=gte.${from}&scheduled_date=lte.${to}&order=scheduled_date.asc`),
    sb('workshop_hotels?select=id,hotel,workshop_name,free_cancel_until,reminder_event_id,reminder_placed,status&reminder_event_id=not.is.null&status=eq.active'),
  ]);

  const habitMap = new Map((habits || []).map((h) => [h.id, h]));
  const hotelByEventId = new Map();
  for (const h of hotels || []) {
    if (h.reminder_event_id) hotelByEventId.set(h.reminder_event_id, h);
  }

  const { events } = await fetchHorizonEvents(timeMin, timeMax);
  const split = splitMcAndBusy(events, ruleMap);
  const mcEvents = split.mc || [];
  const eventById = indexGcalEventsById([
    ...(split.mc || []),
    ...(split.fixtures || []),
    ...(split.busy || []).filter((e) => !e.hard_fixture),
  ]);

  const tiedIds = new Set([
    ...(tasks || []).map((t) => t.calendar_event_id).filter(Boolean),
    ...(logs || []).map((l) => l.calendar_event_id).filter(Boolean),
    ...(travel || []).map((t) => t.calendar_event_id).filter(Boolean),
    ...[...hotelByEventId.keys()],
  ]);

  const busyEvents = (split.busy || [])
    .filter((e) => !e?.id || !tiedIds.has(e.id))
    .filter((e) => !e.hard_fixture);
  const fixtures = (split.fixtures || []).filter((e) => !e?.id || !tiedIds.has(e.id));
  const busyBlocks = busyToBlocks(busyEvents, fixtures);

  const dbBlocks = [
    ...tasksToBlocks(tasks, today),
    ...habitLogsToBlocks(logs, habitMap),
    ...travelToBlocks(travel),
    ...busyBlocks,
  ];
  const { blocks: baselined } = applyGcalBaselineTimes(dbBlocks, eventById);
  const deadlines = hotelDeadlineBlocks(mcEvents, hotelByEventId);
  for (const d of deadlines) {
    if (d.calendar_event_id) tiedIds.add(d.calendar_event_id);
  }
  const orphans = untiedMcBlocks(mcEvents, tiedIds);
  const diaryBlocks = insertDecompressStrips([...baselined, ...deadlines, ...orphans], ruleMap)
    .filter((b) => b.day >= from && b.day <= to && Number.isFinite(b.start_min));

  // Primary timed GCal (all calendars already in fetchHorizonEvents)
  const gcalTimed = (events || []).filter((e) => {
    if (e.status === 'cancelled') return false;
    const start = e.start?.dateTime || e.start;
    return start && String(start).includes('T');
  }).map((e) => {
    const start = String(e.start.dateTime || e.start);
    const end = String(e.end?.dateTime || e.end || start);
    const day = isoToLondonDate(start);
    return {
      id: e.id,
      title: e.summary || '(untitled)',
      day,
      start,
      end,
      start_min: isoToLondonMinutes(start),
      end_min: isoToLondonMinutes(end),
      calendarId: e._calendarId || 'primary',
    };
  }).filter((b) => b.day >= from && b.day <= to);

  // Match diary ↔ gcal by soft key (day + 5min bucket + norm title)
  const gcalBySoft = new Map();
  for (const g of gcalTimed) {
    const k = softKey(g.day, g.start_min, g.title);
    if (!gcalBySoft.has(k)) gcalBySoft.set(k, []);
    gcalBySoft.get(k).push(g);
  }

  const matchedGcal = new Set();
  const onlyDiary = [];
  const timeDrift = [];
  const matched = [];

  for (const d of diaryBlocks) {
    if (d.synthetic) {
      onlyDiary.push({ ...d, cause: 'synthetic_decompress_only_in_mc' });
      continue;
    }
    const k = softKey(d.day, d.start_min, d.title);
    const cands = gcalBySoft.get(k) || [];
    // Also try calendar_event_id exact
    let hit = null;
    if (d.calendar_event_id) {
      hit = gcalTimed.find((g) => g.id === d.calendar_event_id) || null;
    }
    if (!hit && cands.length) {
      hit = cands.find((g) => !matchedGcal.has(g.id)) || cands[0];
    }
    // Fuzzy: same day, title norm match, start within 20 min
    if (!hit) {
      const nt = normTitle(d.title);
      hit = gcalTimed.find((g) => {
        if (matchedGcal.has(g.id)) return false;
        if (g.day !== d.day) return false;
        if (normTitle(g.title) !== nt) return false;
        return Math.abs(g.start_min - d.start_min) <= 20;
      }) || null;
    }
    if (!hit) {
      onlyDiary.push({
        ...d,
        cause: d.gcal_orphan ? 'orphan_paint_missing_from_gcal_fetch?' 
          : (!d.calendar_event_id ? 'mc_block_without_calendar_event_id' : 'gcal_event_missing_or_cancelled'),
      });
      continue;
    }
    matchedGcal.add(hit.id);
    const drift = Math.abs(hit.start_min - d.start_min) + Math.abs(hit.end_min - d.end_min);
    if (drift > 2) {
      timeDrift.push({
        day: d.day,
        title: d.title,
        diary: `${hm(d.start)}–${hm(d.end)}`,
        gcal: `${hm(hit.start)}–${hm(hit.end)}`,
        drift_min: drift,
        event_id: hit.id,
        cause: 'time_drift_db_vs_gcal',
      });
    } else {
      matched.push({ day: d.day, title: d.title, when: `${hm(d.start)}–${hm(d.end)}` });
    }
  }

  const onlyGcal = gcalTimed.filter((g) => !matchedGcal.has(g.id)).map((g) => {
    const isMc = /^MC\b|^P[0-3]\s*[·•]|^DONE\b/i.test(g.title);
    const isDecomp = /decompress/i.test(g.title);
    let cause = 'personal_or_external_ok';
    if (isMc && isDecomp) cause = 'gcal_decompress_not_in_diary_paint';
    else if (isMc) cause = 'mc_managed_on_gcal_missing_from_diary';
    else if (/Travel|Prep —/i.test(g.title)) cause = 'travel_buffer_missing_from_diary';
    return { ...g, cause, when: `${hm(g.start)}–${hm(g.end)}` };
  });

  const report = {
    range: { from, to, weeks: WEEKS, today },
    counts: {
      diary_blocks: diaryBlocks.length,
      gcal_timed: gcalTimed.length,
      matched: matched.length,
      time_drift: timeDrift.length,
      only_in_diary: onlyDiary.length,
      only_in_gcal: onlyGcal.length,
      only_in_gcal_mc: onlyGcal.filter((x) => x.cause !== 'personal_or_external_ok').length,
    },
    only_in_diary: onlyDiary
      .map((d) => ({
        day: d.day,
        when: `${hm(d.start)}–${hm(d.end)}`,
        title: d.title,
        kind: d.kind,
        done: !!d.done,
        event_id: d.calendar_event_id || null,
        cause: d.cause,
      }))
      .sort((a, b) => a.day.localeCompare(b.day) || a.when.localeCompare(b.when)),
    time_drift: timeDrift.sort((a, b) => a.day.localeCompare(b.day)),
    only_in_gcal_mc: onlyGcal
      .filter((x) => x.cause !== 'personal_or_external_ok')
      .map((g) => ({
        day: g.day,
        when: g.when,
        title: g.title,
        calendar: g.calendarId,
        event_id: g.id,
        cause: g.cause,
      }))
      .sort((a, b) => a.day.localeCompare(b.day) || a.when.localeCompare(b.when)),
    only_in_gcal_personal_sample: onlyGcal
      .filter((x) => x.cause === 'personal_or_external_ok')
      .slice(0, 40)
      .map((g) => ({ day: g.day, when: g.when, title: g.title, calendar: g.calendarId })),
  };

  const outPath = path.join(__dirname, '..', 'tmp', `mc-gcal-diff-${from}_to_${to}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.counts, null, 2));
  console.log('wrote', outPath);
  console.log('\n=== ONLY IN DIARY (first 40) ===');
  for (const r of report.only_in_diary.slice(0, 40)) {
    console.log(`${r.day} ${r.when} [${r.kind}] ${r.title} :: ${r.cause}`);
  }
  console.log('\n=== TIME DRIFT ===');
  for (const r of report.time_drift.slice(0, 40)) {
    console.log(`${r.day} ${r.title} diary=${r.diary} gcal=${r.gcal} drift=${r.drift_min}m`);
  }
  console.log('\n=== ONLY IN GCAL (MC-managed) ===');
  for (const r of report.only_in_gcal_mc.slice(0, 40)) {
    console.log(`${r.day} ${r.when} ${r.title} :: ${r.cause}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
