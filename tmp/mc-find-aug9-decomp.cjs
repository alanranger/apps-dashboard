const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { getAccessToken } = require('../api/mc/gcal-lib');
const { deletePrimaryEvent } = require('../api/mc/gcal-write-lib');
const CAL_API = 'https://www.googleapis.com/calendar/v3';
const APPLY = process.argv.includes('--apply');

async function gcalGet(path) {
  const token = await getAccessToken();
  const res = await fetch(`${CAL_API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data;
}

(async () => {
  const q = new URLSearchParams({
    timeMin: '2026-08-09T00:00:00+01:00',
    timeMax: '2026-08-10T00:00:00+01:00',
    singleEvents: 'true',
    showDeleted: 'true',
    maxResults: '250',
  });
  const data = await gcalGet(`/calendars/primary/events?${q}`);
  const rows = (data.items || [])
    .filter((e) => /decompress|MC-9|citation/i.test(e.summary || ''))
    .map((e) => ({
      id: e.id,
      summary: e.summary,
      status: e.status,
      start: e.start?.dateTime || e.start?.date,
      end: e.end?.dateTime || e.end?.date,
    }));
  console.log(JSON.stringify(rows, null, 2));
  if (APPLY) {
    for (const e of rows.filter((x) => x.status !== 'cancelled' && /decompress/i.test(x.summary || ''))) {
      await deletePrimaryEvent(e.id);
      console.log('deleted', e.id);
    }
  }
})().catch((e) => { console.error(e); process.exit(1); });
