/**
 * Deep verify Backup/EventSchema pins + Upload-after-BAU2 gaps.
 * node scripts/mc-three-way-verify-deep.cjs
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { sb } = require('../api/mc/_lib');
const { idealsInHorizon } = require('../api/mc/rrule-core');
const { getAccessToken } = require('../api/mc/gcal-lib');

const ANCHOR = '2026-07-30';

async function getEvent(token, id) {
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(id)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const j = await res.json();
  return { http: res.status, ...j };
}

function latestPin(logs, ideal) {
  const rows = (logs || []).filter((r) => r.ideal_date === ideal);
  const pin = rows.find((r) => /diary_pin/i.test(r.change || '') && r.calendar_event_id);
  return pin || rows[0] || null;
}

(async () => {
  const token = await getAccessToken();
  const titles = [
    'Backup Photos to Portable Drive',
    'Update Event Schema for Classes & Workshops',
    'Upload sites — LocalViking, TOGDays, Where Can We Go',
    'BAU global refresh — Day 2: schemas + final ingest + verify',
  ];

  for (const title of titles) {
    const habit = (await sb(`recurring_tasks?title=eq.${encodeURIComponent(title)}&select=id,title,rrule,duration_min`))[0];
    if (!habit) { console.log('MISSING', title); continue; }
    const ideals = idealsInHorizon(habit.rrule, ANCHOR, '2027-02-28', 200, ANCHOR);
    const logs = await sb(
      `recurring_log?recurring_task_id=eq.${habit.id}&ideal_date=gte.${ANCHOR}&select=ideal_date,scheduled_date,change,calendar_event_id,at&order=at.desc&limit=100`,
    );
    console.log(`\n## ${habit.title}`);
    for (const ideal of ideals) {
      const row = latestPin(logs, ideal);
      let ev = null;
      if (row?.calendar_event_id) ev = await getEvent(token, row.calendar_event_id);
      const mins = ev?.start?.dateTime && ev?.end?.dateTime
        ? Math.round((Date.parse(ev.end.dateTime) - Date.parse(ev.start.dateTime)) / 60000)
        : null;
      console.log({
        ideal,
        db: row ? { scheduled: row.scheduled_date, change: (row.change || '').slice(0, 70), eid: row.calendar_event_id } : null,
        gcal: ev ? { status: ev.status, start: ev.start?.dateTime, end: ev.end?.dateTime, mins, summary: (ev.summary || '').slice(0, 50), err: ev.error?.message } : null,
        duration_ok: mins == null ? null : Math.abs(mins - habit.duration_min) <= 5,
      });
    }
  }

  // Upload vs BAU2 timing
  const bau2 = (await sb(`recurring_tasks?title=ilike.${encodeURIComponent('BAU global refresh — Day 2*')}&select=id,title`))[0];
  const upload = (await sb(`recurring_tasks?title=ilike.${encodeURIComponent('Upload sites*')}&select=id,title`))[0];
  const bauLogs = await sb(`recurring_log?recurring_task_id=eq.${bau2.id}&select=ideal_date,scheduled_date,change,calendar_event_id,at&order=at.desc&limit=40`);
  const upLogs = await sb(`recurring_log?recurring_task_id=eq.${upload.id}&select=ideal_date,scheduled_date,change,calendar_event_id,at&order=at.desc&limit=40`);

  const bauPins = [...new Map((bauLogs || []).filter((r) => /diary_pin/i.test(r.change || '') && r.calendar_event_id).map((r) => [r.calendar_event_id, r])).values()];
  const upPins = [...new Map((upLogs || []).filter((r) => /diary_pin/i.test(r.change || '') && r.calendar_event_id).map((r) => [r.calendar_event_id, r])).values()];

  console.log('\n## Upload after BAU2 (live GCal)');
  for (const u of upPins) {
    const ue = await getEvent(token, u.calendar_event_id);
    if (ue.status !== 'confirmed') continue;
    const uStart = Date.parse(ue.start.dateTime);
    let best = null;
    for (const b of bauPins) {
      const be = await getEvent(token, b.calendar_event_id);
      if (be.status !== 'confirmed') continue;
      const gapH = (uStart - Date.parse(be.end.dateTime)) / 3600000;
      if (gapH < -1) continue;
      if (!best || Math.abs(gapH) < Math.abs(best.gapH)) best = { bau_end: be.end.dateTime, gapH };
    }
    console.log({
      upload_start: ue.start.dateTime,
      upload_end: ue.end.dateTime,
      nearest_bau2_end: best?.bau_end,
      gap_hours: best ? Math.round(best.gapH * 10) / 10 : null,
      within_24h: best ? best.gapH >= 0 && best.gapH <= 24 : false,
    });
  }

  const pendingSample = await sb(
    'pending_diary_changes?status=eq.pending&select=id,change_type,summary,related_id,created_at&order=created_at.desc&limit=15',
  );
  console.log('\n## pending_diary sample', pendingSample);
})().catch((e) => { console.error(e); process.exit(1); });
