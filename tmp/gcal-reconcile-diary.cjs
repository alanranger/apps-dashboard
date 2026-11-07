/**
 * Reconcile diary horizon: DB master blocks ↔ Google primary MC events ↔ live diary API.
 * Usage: node tmp/gcal-reconcile-diary.cjs
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto'); // unused; keep require quiet

const root = path.join(__dirname, '..');
for (const line of fs.readFileSync(path.join(root, '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { sb } = require('../api/mc/_lib.js');
const {
  londonToday, addDaysYmd, mondayOnOrBefore, ruleMapFromRows,
  parseDiaryPin, habitLogsToBlocks, tasksToBlocks, travelToBlocks,
} = require('../api/mc/diary-lib.js');
const { fetchHorizonEvents, getAccessToken } = require('../api/mc/gcal-lib.js');
const { isMcBlock } = require('../api/mc/rule-breach-lib.js');
const { isoToLondonDate } = require('../api/mc/scheduling-rules-lib.js');

const TOL_MS = 2 * 60 * 1000;
const WEEKS = 8;

function eventStartEnd(e) {
  const start = e.start?.dateTime || (e.start?.date ? `${e.start.date}T00:00:00.000Z` : null);
  const end = e.end?.dateTime || (e.end?.date ? `${e.end.date}T00:00:00.000Z` : null);
  return { start, end };
}

function closeEnough(a, b) {
  if (!a || !b) return false;
  return Math.abs(Date.parse(a) - Date.parse(b)) <= TOL_MS;
}

function isSkipped(change) {
  return /^skipped\b/i.test(String(change || ''));
}

async function fetchLiveDiary(from, weeks) {
  const authRes = await fetch('https://apps-dashboard-lilac.vercel.app/api/mc/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: process.env.MC_AGENT_PASSWORD || process.env.MC_ALAN_PASSWORD }),
  });
  const auth = await authRes.json();
  if (!auth.token) return { error: auth.error || 'auth_failed', status: authRes.status };
  const url = `https://apps-dashboard-lilac.vercel.app/api/mc/diary?from=${from}&weeks=${weeks}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${auth.token}`, 'x-mc-token': auth.token },
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }
  return { status: res.status, data };
}

async function main() {
  const today = londonToday();
  const from = mondayOnOrBefore(today);
  const to = addDaysYmd(from, WEEKS * 7 - 1);
  const timeMin = `${from}T00:00:00.000Z`;
  const timeMax = `${addDaysYmd(to, 1)}T00:00:00.000Z`;

  const rules = await sb('scheduling_rules?select=key,value');
  const ruleMap = ruleMapFromRows(rules || []);

  const [tasks, travel, habits, logs] = await Promise.all([
    sb(`tasks?select=id,display_id,title,state,scheduled_start,scheduled_end,calendar_event_id&scheduled_start=gte.${timeMin}&scheduled_start=lt.${timeMax}&order=scheduled_start.asc`),
    sb(`travel_blocks?select=id,block_type,venue_name,starts_at,ends_at,calendar_event_id&starts_at=gte.${timeMin}&starts_at=lt.${timeMax}&order=starts_at.asc`),
    sb('recurring_tasks?select=id,title,duration_min,ideal_time,priority,active,last_done&active=eq.true'),
    sb(`recurring_log?select=id,recurring_task_id,ideal_date,scheduled_date,calendar_event_id,change,at&scheduled_date=gte.${from}&scheduled_date=lte.${to}&order=scheduled_date.asc`),
  ]);

  const habitMap = new Map((habits || []).map((h) => [h.id, h]));
  const activeLogs = (logs || []).filter((l) => !isSkipped(l.change));
  const dbHabitBlocks = habitLogsToBlocks(activeLogs, habitMap);
  const dbTaskBlocks = tasksToBlocks(tasks || [], today);
  const dbTravelBlocks = travelToBlocks(travel || []);

  const dbItems = [
    ...dbHabitBlocks.filter((b) => !b.done).map((b) => ({
      kind: 'habit', id: b.id, title: b.title, start: b.start, end: b.end,
      calendar_event_id: b.calendar_event_id, source: 'recurring_log',
    })),
    ...dbTaskBlocks.filter((b) => !b.done).map((b) => ({
      kind: 'task', id: b.id, title: b.title, start: b.start, end: b.end,
      calendar_event_id: b.calendar_event_id, source: 'tasks',
    })),
    ...dbTravelBlocks.filter((b) => b.kind === 'travel').map((b) => ({
      kind: 'travel', id: b.id, title: b.title, start: b.start, end: b.end,
      calendar_event_id: b.calendar_event_id, source: 'travel_blocks',
    })),
  ];

  const { events, assessment } = await fetchHorizonEvents(timeMin, timeMax);
  const primaryMc = (events || []).filter((e) => {
    if (e._calendarId && e._calendarId !== 'primary') return false;
    return isMcBlock(e, ruleMap);
  });
  const byId = new Map(primaryMc.map((e) => [e.id, e]));
  // Also index all primary events (non-MC) in case ids point there
  for (const e of events || []) {
    if (e._calendarId === 'primary' && e.id && !byId.has(e.id)) byId.set(e.id, e);
  }

  // One calendar event → one DB intent (prefer pinned / later).
  const byEvent = new Map();
  for (const item of dbItems) {
    if (!item.calendar_event_id) continue;
    const prev = byEvent.get(item.calendar_event_id);
    if (!prev) {
      byEvent.set(item.calendar_event_id, item);
      continue;
    }
    // Prefer habit pin-looking ISO equality later start? keep first habit with matching day
    if (item.kind === 'habit' && prev.kind === 'habit') {
      const itemPin = /diary_pin:/.test(String(item._change || ''));
      const prevPin = /diary_pin:/.test(String(prev._change || ''));
      if (itemPin && !prevPin) byEvent.set(item.calendar_event_id, item);
      else if (!itemPin && prevPin) { /* keep prev */ }
      else if (String(item.start) > String(prev.start)) byEvent.set(item.calendar_event_id, item);
    }
  }
  const dbItemsForGcal = [
    ...dbItems.filter((i) => !i.calendar_event_id),
    ...byEvent.values(),
  ];

  const matched = [];
  const timeMismatch = [];
  const missingInGcal = [];
  const missingEventId = [];
  const referencedIds = new Set();

  for (const item of dbItemsForGcal) {
    if (!item.calendar_event_id) {
      missingEventId.push({
        kind: item.kind, title: item.title, start: item.start, end: item.end, id: item.id,
      });
      continue;
    }
    referencedIds.add(item.calendar_event_id);
    const ev = byId.get(item.calendar_event_id);
    if (!ev) {
      missingInGcal.push({
        kind: item.kind, title: item.title, event_id: item.calendar_event_id,
        start: item.start, end: item.end, id: item.id,
      });
      continue;
    }
    const { start, end } = eventStartEnd(ev);
    if (closeEnough(item.start, start) && closeEnough(item.end, end)) {
      matched.push({
        kind: item.kind, title: item.title, event_id: item.calendar_event_id,
        start: item.start,
      });
    } else {
      timeMismatch.push({
        kind: item.kind,
        title: item.title,
        event_id: item.calendar_event_id,
        db: { start: item.start, end: item.end },
        gcal: { start, end, summary: ev.summary },
      });
    }
  }

  const orphansRaw = primaryMc.filter((e) => !referencedIds.has(e.id)).map((e) => {
    const { start, end } = eventStartEnd(e);
    const summary = e.summary || '';
    let bucket = 'other';
    if (/MC ⏳|Prep —|Decompress —/.test(summary)) bucket = 'buffer';
    else if (/MC ⏰/.test(summary)) bucket = 'reminder';
    else if (/MC ⚽/.test(summary)) bucket = 'fixture';
    else if (/MC 🔁|MC 🚗/.test(summary)) bucket = 'habit_or_travel';
    else if (/MC-\d+/.test(summary)) bucket = 'task_card';
    return {
      event_id: e.id,
      summary,
      start,
      end,
      day: start ? isoToLondonDate(start) : null,
      bucket,
    };
  });
  const orphansExpected = orphansRaw.filter((o) => (
    o.bucket === 'buffer' || o.bucket === 'reminder' || o.bucket === 'fixture' || o.bucket === 'task_card'
  ));
  const orphansUnexpected = orphansRaw.filter((o) => (
    o.bucket === 'habit_or_travel' || o.bucket === 'other'
  ));
  const orphans = orphansRaw;

  // Live diary API vs DB
  const live = await fetchLiveDiary(from, WEEKS);
  let diaryVsDb = { ok: false, error: null, compared: 0, mismatches: [] };
  if (live.error || live.status !== 200) {
    diaryVsDb.error = live.error || `http_${live.status}`;
  } else {
    const liveBlocks = (live.data.blocks || []).filter((b) => (
      b.kind === 'habit' || b.kind === 'mc_task' || b.kind === 'travel'
    ));
    const dbByKey = new Map();
    for (const item of dbItems) {
      dbByKey.set(`${item.kind}|${item.start}|${item.title}`, item);
      if (item.calendar_event_id) dbByKey.set(`evt:${item.calendar_event_id}`, item);
    }
    diaryVsDb.ok = true;
    diaryVsDb.live_block_count = liveBlocks.length;
    diaryVsDb.compared = liveBlocks.length;
    for (const b of liveBlocks) {
      const kind = b.kind === 'mc_task' ? 'task' : b.kind;
      let db = b.calendar_event_id ? dbByKey.get(`evt:${b.calendar_event_id}`) : null;
      if (!db) db = dbByKey.get(`${kind}|${b.start}|${b.title}`);
      if (!db) {
        diaryVsDb.mismatches.push({
          type: 'live_not_in_db_blocks',
          kind: b.kind, title: b.title, start: b.start, event_id: b.calendar_event_id,
        });
        continue;
      }
      if (!closeEnough(db.start, b.start) || !closeEnough(db.end, b.end)) {
        diaryVsDb.mismatches.push({
          type: 'live_time_differs_from_db',
          kind: b.kind, title: b.title,
          live: { start: b.start, end: b.end },
          db: { start: db.start, end: db.end },
        });
      }
    }
    diaryVsDb.mismatch_count = diaryVsDb.mismatches.length;
  }

  const openPush = await sb('gcal_push_queue?status=in.(pending,ready)&select=id,change_kind,entity_type,summary');
  const report = {
    at: new Date().toISOString(),
    horizon: { from, to, weeks: WEEKS, today },
    gcal_health: assessment,
    counts: {
      db_items: dbItems.length,
      db_habits: dbHabitBlocks.length,
      db_tasks: dbTaskBlocks.length,
      db_travel: dbTravelBlocks.length,
      primary_mc_events: primaryMc.length,
      matched: matched.length,
      time_mismatch: timeMismatch.length,
      missing_in_gcal: missingInGcal.length,
      missing_event_id: missingEventId.length,
      orphan_gcal_mc_all: orphans.length,
      orphan_unexpected: orphansUnexpected.length,
      orphan_expected_buffers_reminders_fixtures: orphansExpected.length,
      push_queue_open: (openPush || []).length,
      diary_vs_db_mismatches: diaryVsDb.mismatch_count ?? null,
    },
    aligned: timeMismatch.length === 0
      && missingInGcal.length === 0
      && orphansUnexpected.length === 0
      && (diaryVsDb.mismatch_count === 0),
    soft_aligned: timeMismatch.length === 0
      && missingInGcal.length === 0
      && orphansUnexpected.length === 0,
    time_mismatch: timeMismatch,
    missing_in_gcal: missingInGcal,
    missing_event_id: missingEventId.slice(0, 40),
    missing_event_id_total: missingEventId.length,
    orphan_gcal_mc: orphansUnexpected.slice(0, 40),
    orphan_gcal_mc_total: orphansUnexpected.length,
    orphan_expected_sample: orphansExpected.slice(0, 10),
    orphan_expected_total: orphansExpected.length,
    diary_vs_db: {
      ...diaryVsDb,
      mismatches: (diaryVsDb.mismatches || []).slice(0, 30),
    },
    open_push: openPush || [],
  };

  // Strict "finally aligned" for writable surface: times match + no missing events for rows that have ids
  report.verdict = report.soft_aligned
    ? (report.aligned
      ? 'ALIGNED'
      : 'DB↔GCal OK; diary API residual only — review diary_vs_db')
    : 'MISALIGNED — see time_mismatch / missing_in_gcal / unexpected orphans';

  const outPath = path.join(root, 'tmp/gcal-reconcile-diary-LATEST.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    verdict: report.verdict,
    counts: report.counts,
    soft_aligned: report.soft_aligned,
    aligned: report.aligned,
    sample_time_mismatch: timeMismatch.slice(0, 5),
    sample_missing_gcal: missingInGcal.slice(0, 5),
    sample_orphans: orphansUnexpected.slice(0, 5),
    open_push: (openPush || []).map((p) => p.summary),
  }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
