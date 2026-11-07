/**
 * Verify BAU + Upload on GCal; nudge Upload to after live BAU2 when needed.
 * node scripts/mc-verify-bau-upload.cjs
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { getAccessToken } = require('../api/mc/gcal-lib');
const { sb } = require('../api/mc/_lib');

const UPLOAD_ID = 'e6d11356-6276-48af-a5d3-58874c31ce5d';

async function search(token, q, timeMin, timeMax) {
  const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime`
    + `&timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}`
    + `&q=${encodeURIComponent(q)}&maxResults=40`;
  const j = await fetch(url, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());
  return (j.items || []).filter((e) => e.status !== 'cancelled').map((e) => ({
    id: e.id,
    summary: e.summary,
    start: e.start?.dateTime || e.start?.date,
    end: e.end?.dateTime || e.end?.date,
  }));
}

function londonYmd(ms) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ms));
}

function londonHour(ms) {
  return Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', hour: 'numeric', hour12: false,
  }).format(new Date(ms)));
}

async function patchLondon(token, eventId, ymd, startHm, endHm) {
  const body = {
    start: { dateTime: `${ymd}T${startHm}:00`, timeZone: 'Europe/London' },
    end: { dateTime: `${ymd}T${endHm}:00`, timeZone: 'Europe/London' },
  };
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`,
    {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  const j = await res.json();
  if (!res.ok) throw new Error(j.error?.message || `patch failed ${res.status}`);
  return j;
}

(async () => {
  const token = await getAccessToken();
  const bau = await search(token, 'BAU global refresh', '2026-08-25T00:00:00Z', '2027-03-01T00:00:00Z');
  const upload = await search(token, 'Upload sites', '2026-08-25T00:00:00Z', '2027-03-01T00:00:00Z');
  console.log('BAU', bau.map((b) => ({ s: b.summary.slice(0, 40), start: b.start, end: b.end })));
  console.log('UPLOAD', upload.map((u) => ({ start: u.start, end: u.end, id: u.id })));

  const bau2 = bau.filter((b) => /Day 2/i.test(b.summary || ''))
    .map((b) => ({ ...b, endMs: Date.parse(b.end), startMs: Date.parse(b.start) }))
    .sort((a, b) => a.endMs - b.endMs);

  for (const u of upload) {
    const uStart = Date.parse(u.start);
    const prior = [...bau2].filter((b) => b.endMs <= uStart).sort((a, b) => b.endMs - a.endMs)[0];
    const gapH = prior ? (uStart - prior.endMs) / 3600000 : null;
    const ok = prior && gapH >= 0 && gapH <= 24;
    console.log('check', { upload: u.start, prior: prior?.end, gapH, ok });
    if (ok) continue;

    // Anchor to nearest BAU2 in the same cycle (~ within 20 days)
    const anchor = bau2.find((b) => Math.abs(b.endMs - uStart) < 20 * 86400000)
      || bau2.find((b) => b.endMs > uStart - 5 * 86400000 && b.endMs < uStart + 20 * 86400000);
    if (!anchor) {
      console.log('no_anchor', u.id);
      continue;
    }
    const afterMs = anchor.endMs + 15 * 60000;
    let ymd;
    let startHm;
    let endHm;
    if (londonHour(afterMs) <= 14) {
      ymd = londonYmd(afterMs);
      // keep 15m after BAU2 — express as London wall roughly via ISO already on event
      const startIso = new Date(afterMs).toISOString();
      const endIso = new Date(afterMs + 180 * 60000).toISOString();
      await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events/${u.id}`,
        {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            start: { dateTime: startIso, timeZone: 'Europe/London' },
            end: { dateTime: endIso, timeZone: 'Europe/London' },
          }),
        },
      );
      console.log('moved_same_day', u.id, startIso);
    } else {
      // next London morning 10:00–13:00
      const nextDayMs = anchor.endMs + 20 * 3600000;
      ymd = londonYmd(nextDayMs);
      startHm = '10:00';
      endHm = '13:00';
      await patchLondon(token, u.id, ymd, startHm, endHm);
      console.log('moved_next_morning', u.id, ymd, startHm);
    }

    await sb('recurring_log', {
      method: 'POST', prefer: 'return=minimal',
      body: {
        recurring_task_id: UPLOAD_ID,
        at: new Date().toISOString(),
        actor: 'cursor',
        change: `diary_pin_nudge_after_bau2|${u.id}`,
        scheduled_date: ymd || londonYmd(afterMs),
        calendar_event_id: u.id,
      },
    });
  }

  const upload2 = await search(token, 'Upload sites', '2026-08-25T00:00:00Z', '2027-03-01T00:00:00Z');
  console.log('UPLOAD_FINAL', upload2.map((u) => ({ start: u.start, end: u.end })));
  const ghosts = await search(token, 'BAU global refresh', '2026-08-15T00:00:00Z', '2026-08-20T23:59:59Z');
  console.log('aug17_19_bau', ghosts);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
