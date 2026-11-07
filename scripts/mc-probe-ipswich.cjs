const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { fetchHorizonEvents } = require('../api/mc/gcal-lib');
(async () => {
  const { events } = await fetchHorizonEvents('2026-08-22T00:00:00Z', '2026-08-23T00:00:00Z');
  const hits = (events || []).filter((e) => /ipswich|sunderland/i.test(e.summary || ''));
  console.log(JSON.stringify(hits.map((e) => ({
    id: e.id, summary: e.summary, start: e.start, end: e.end, cal: e._calendarId,
  })), null, 2));
  console.log('total events', (events || []).length);
})().catch((e) => { console.error(e); process.exit(1); });
