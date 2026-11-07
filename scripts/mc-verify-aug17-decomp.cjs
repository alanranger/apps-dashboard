const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { getAccessToken } = require('../api/mc/gcal-lib');
(async () => {
  const t = await getAccessToken();
  const url = 'https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime'
    + `&timeMin=${encodeURIComponent('2026-08-17T00:00:00Z')}`
    + `&timeMax=${encodeURIComponent('2026-08-24T00:00:00Z')}`
    + `&q=${encodeURIComponent('Decompress')}&maxResults=40`;
  const j = await fetch(url, { headers: { Authorization: `Bearer ${t}` } }).then((r) => r.json());
  console.log((j.items || []).filter((e) => e.status !== 'cancelled').map((e) => ({
    start: e.start.dateTime, summary: e.summary,
  })));
})().catch((e) => { console.error(e); process.exit(1); });
