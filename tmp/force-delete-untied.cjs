const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '..', '.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const { sb } = require('../api/mc/_lib.js');
const { fetchHorizonEvents, gcalConfigured } = require('../api/mc/gcal-lib.js');
const { deletePrimaryEvent } = require('../api/mc/gcal-write-lib.js');
const { isoToLondonDate } = require('../api/mc/scheduling-rules-lib.js');

(async () => {
  const from = '2026-08-10';
  const to = '2026-08-16';
  const { events } = await fetchHorizonEvents(`${from}T00:00:00Z`, `${to}T23:59:59Z`);
  const logs = await sb('recurring_log?select=calendar_event_id&calendar_event_id=not.is.null&limit=2000');
  const tied = new Set((logs || []).map((r) => r.calendar_event_id).filter(Boolean));
  let n = 0;
  for (const e of events || []) {
    if ((e._calendarId || 'primary') !== 'primary') continue;
    if (!e.start?.dateTime || e.status === 'cancelled') continue;
    if (!/^MC\s*🔁/u.test(String(e.summary || ''))) continue;
    const day = isoToLondonDate(e.start.dateTime);
    if (day < from || day > to) continue;
    if (tied.has(e.id)) continue;
    await deletePrimaryEvent(e.id);
    console.log('deleted untied', day, e.summary, e.id);
    n += 1;
  }
  // If multiple Claude this week keep earliest one only on/after Aug 10
  const { events: after } = await fetchHorizonEvents(`${from}T00:00:00Z`, `${to}T23:59:59Z`);
  const claude = (after || []).filter(
    (e) => (e._calendarId || 'primary') === 'primary'
      && /Claude monthly hotel scan/i.test(String(e.summary || '')) && e.start?.dateTime,
  ).sort((a, b) => Date.parse(a.start.dateTime) - Date.parse(b.start.dateTime));
  for (const e of claude.slice(1)) {
    await deletePrimaryEvent(e.id);
    console.log('deleted extra Claude', e.id, e.start.dateTime);
    n += 1;
  }
  console.log('total deleted', n);
  const { events: final } = await fetchHorizonEvents(`${from}T00:00:00Z`, `${to}T23:59:59Z`);
  const mc = (final || []).filter(
    (e) => (e._calendarId || 'primary') === 'primary' && e.start?.dateTime
      && /^MC\s*🔁/u.test(String(e.summary || '')),
  ).sort((a, b) => Date.parse(a.start.dateTime) - Date.parse(b.start.dateTime));
  for (const e of mc) {
    console.log(isoToLondonDate(e.start.dateTime), String(e.start.dateTime).slice(11, 16), e.summary);
  }
})().catch((e) => { console.error(e); process.exit(1); });
