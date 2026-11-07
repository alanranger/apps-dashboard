/**
 * Fix post-cleanup: Aug9 orphan decompress + Upload off AWAY onto Sep9 after BAU2.
 * node scripts/mc-fix-upload-ruby-followup.cjs
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { sb } = require('../api/mc/_lib');
const { getAccessToken } = require('../api/mc/gcal-lib');
const { deletePrimaryEvent } = require('../api/mc/gcal-write-lib');

const UPLOAD_ID = 'e6d11356-6276-48af-a5d3-58874c31ce5d';
const IDEAL = '2026-08-26';

(async () => {
  const token = await getAccessToken();

  // 1) Delete orphan decompress on Aug 9
  const d9 = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true`
    + `&timeMin=${encodeURIComponent('2026-08-09T00:00:00+01:00')}`
    + `&timeMax=${encodeURIComponent('2026-08-09T23:59:59+01:00')}`
    + `&q=${encodeURIComponent('Decompress')}`,
    { headers: { Authorization: `Bearer ${token}` } },
  ).then((r) => r.json());
  for (const e of d9.items || []) {
    if (e.status === 'cancelled') continue;
    if (!/Decompress.*MC-9|Decompress.*AI-citation/i.test(e.summary || '')) continue;
    await deletePrimaryEvent(e.id);
    console.log('deleted_aug9_orphan', e.id, e.summary);
  }

  // 2) Find Upload on Sep 10 and move to Sep 9 12:30-15:30
  const search = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime`
    + `&timeMin=${encodeURIComponent('2026-09-08T00:00:00+01:00')}`
    + `&timeMax=${encodeURIComponent('2026-09-11T23:59:59+01:00')}`
    + `&q=${encodeURIComponent('Upload sites')}`,
    { headers: { Authorization: `Bearer ${token}` } },
  ).then((r) => r.json());
  const uploads = (search.items || []).filter((e) => e.status !== 'cancelled' && /Upload sites/i.test(e.summary || ''));
  console.log('uploads_found', uploads.map((e) => ({ id: e.id, start: e.start?.dateTime, end: e.end?.dateTime })));

  for (const e of uploads) {
    const body = {
      start: { dateTime: '2026-09-09T12:30:00', timeZone: 'Europe/London' },
      end: { dateTime: '2026-09-09T15:30:00', timeZone: 'Europe/London' },
    };
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events/${e.id}`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    const j = await res.json();
    if (!res.ok) throw new Error(j.error?.message || 'patch failed');
    console.log('moved_upload', e.id, j.start, j.end);
    await sb('recurring_log', {
      method: 'POST', prefer: 'return=minimal',
      body: {
        recurring_task_id: UPLOAD_ID,
        at: new Date().toISOString(),
        actor: 'cursor',
        change: 'diary_pin:2026-09-09T11:30:00.000Z|2026-09-09T14:30:00.000Z|after_bau2_fix',
        ideal_date: IDEAL,
        scheduled_date: '2026-09-09',
        calendar_event_id: e.id,
        projection_key: `${UPLOAD_ID}|${IDEAL}`,
      },
    });
  }

  // Verify
  const v = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime`
    + `&timeMin=${encodeURIComponent('2026-09-08T00:00:00+01:00')}`
    + `&timeMax=${encodeURIComponent('2026-09-10T23:59:59+01:00')}`
    + `&q=${encodeURIComponent('Upload sites')}`,
    { headers: { Authorization: `Bearer ${token}` } },
  ).then((r) => r.json());
  console.log('upload_final', (v.items || []).filter((e) => e.status !== 'cancelled').map((e) => ({
    start: e.start?.dateTime, end: e.end?.dateTime, summary: e.summary,
  })));

  const a9 = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true`
    + `&timeMin=${encodeURIComponent('2026-08-09T00:00:00+01:00')}`
    + `&timeMax=${encodeURIComponent('2026-08-09T23:59:59+01:00')}`,
    { headers: { Authorization: `Bearer ${token}` } },
  ).then((r) => r.json());
  console.log('aug9_left', (a9.items || []).filter((e) => e.status !== 'cancelled').map((e) => ({
    start: e.start?.dateTime || e.start?.date, summary: e.summary,
  })));

  const pending = await sb('pending_diary_changes?status=eq.pending&select=id');
  console.log('pending', (pending || []).length);
})().catch((e) => { console.error(e); process.exit(1); });
