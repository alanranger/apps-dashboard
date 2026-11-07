/**
 * Verify key fixes after remaining-pending cleanup.
 * node scripts/mc-verify-remaining-fixes.cjs
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { sb } = require('../api/mc/_lib');
const { getAccessToken } = require('../api/mc/gcal-lib');

async function day(token, ymd) {
  const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime`
    + `&timeMin=${encodeURIComponent(`${ymd}T00:00:00+01:00`)}`
    + `&timeMax=${encodeURIComponent(`${ymd}T23:59:59+01:00`)}&maxResults=40`;
  const j = await fetch(url, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());
  return (j.items || []).filter((e) => e.status !== 'cancelled').map((e) => ({
    start: e.start?.dateTime || e.start?.date,
    end: e.end?.dateTime || e.end?.date,
    summary: e.summary,
    transparency: e.transparency || 'opaque',
  }));
}

(async () => {
  const token = await getAccessToken();
  const pending = await sb('pending_diary_changes?status=eq.pending&select=id');
  console.log('pending_count', (pending || []).length);

  for (const d of ['2026-08-07', '2026-08-08', '2026-08-09', '2026-08-10', '2026-08-11', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-24', '2026-09-25', '2026-09-30']) {
    const items = await day(token, d);
    const mc = items.filter((e) => /^MC\b|^P\d\s*·\s*MC-/i.test(e.summary || '') || /Ruby Moving/i.test(e.summary || ''));
    console.log(`\n=== ${d} ===`);
    console.log(mc.map((e) => `${(e.start || '').slice(11, 16)}-${(e.end || '').slice(11, 16)} ${e.summary}`));
  }

  // Upload after BAU2 check for early Sep
  const bau = (await day(token, '2026-09-08')).filter((e) => /BAU.*Day 2/i.test(e.summary || ''));
  const upload = [...await day(token, '2026-09-09'), ...await day(token, '2026-09-10')]
    .filter((e) => /Upload sites/i.test(e.summary || ''));
  console.log('\nBAU2', bau);
  console.log('Upload near', upload);
})().catch((e) => { console.error(e); process.exit(1); });
