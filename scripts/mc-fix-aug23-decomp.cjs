/**
 * Fix Aug 23 Abstract Macro decompress to sit after Prep (not overlapping).
 * node scripts/mc-fix-aug23-decomp.cjs
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { getAccessToken } = require('../api/mc/gcal-lib');
const { deletePrimaryEvent, patchPrimaryEvent, insertPrimaryEvent } = require('../api/mc/gcal-write-lib');

(async () => {
  const t = await getAccessToken();
  const url = 'https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime'
    + `&timeMin=${encodeURIComponent('2026-08-23T00:00:00Z')}`
    + `&timeMax=${encodeURIComponent('2026-08-23T23:59:59Z')}&maxResults=40`;
  const j = await fetch(url, { headers: { Authorization: `Bearer ${t}` } }).then((r) => r.json());
  const items = (j.items || []).filter((e) => e.status !== 'cancelled');
  console.log(items.map((e) => ({
    id: e.id, start: e.start?.dateTime || e.start?.date, end: e.end?.dateTime || e.end?.date, summary: e.summary,
  })));

  const prep = items.find((e) => /Prep\s*—\s*Abstract and Macro/i.test(e.summary || ''));
  const bad = items.filter((e) => /Decompress.*Abstract and Macro/i.test(e.summary || ''));
  console.log('prep', prep && { id: prep.id, start: prep.start, end: prep.end });
  for (const d of bad) {
    await deletePrimaryEvent(d.id);
    console.log('deleted_bad', d.id, d.start?.dateTime);
  }
  if (prep?.end?.dateTime) {
    const startIso = prep.end.dateTime;
    const endIso = new Date(Date.parse(startIso) + 30 * 60000).toISOString();
    const ev = await insertPrimaryEvent({
      summary: 'MC ⏳ Decompress — Abstract and Macro Photography Workshop',
      startIso,
      endIso,
      description: 'after_prep_fixed',
    });
    console.log('created', ev.id, startIso, endIso);
  }
})().catch((e) => { console.error(e); process.exit(1); });
