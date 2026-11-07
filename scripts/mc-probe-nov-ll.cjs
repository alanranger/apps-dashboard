/**
 * Probe Nov week calendars + Light & Logic habit fields.
 * node scripts/mc-probe-nov-ll.cjs
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { sb } = require('../api/mc/_lib');
const { fetchHorizonEvents } = require('../api/mc/gcal-lib');
const { isoToLondonDate } = require('../api/mc/scheduling-rules-lib');

async function main() {
  const { events } = await fetchHorizonEvents(
    '2026-11-09T00:00:00.000Z',
    '2026-11-16T00:00:00.000Z',
  );
  for (const e of (events || []).filter((x) => x.start?.dateTime || x.start?.date)
    .sort((a, b) => String(a.start.dateTime || a.start.date)
      .localeCompare(String(b.start.dateTime || b.start.date)))) {
    const start = e.start.dateTime || e.start.date;
    const day = e.start.dateTime ? isoToLondonDate(e.start.dateTime) : e.start.date;
    const t = e.start.dateTime ? e.start.dateTime.slice(11, 16) : 'allday';
    console.log(day, t, (e._calendarId || 'primary').slice(0, 18), String(e.summary || '').slice(0, 95));
  }

  const h = await sb('recurring_tasks?id=eq.c2f135c9-7146-415d-8231-c2460a064e94&select=*');
  console.log('\nLL habit keys', Object.keys(h?.[0] || {}));
  console.log(JSON.stringify(h?.[0] || {}, null, 2));

  const hotels = await sb(
    'workshop_hotels?select=id,hotel_name,cancel_by,reminder_event_id,reminder_placed,workshop_title'
    + '&or=(hotel_name.ilike.*White%20Horse*,hotel_name.ilike.*OVERSTRAND*)&limit=20',
  );
  console.log('\nWhite Horse hotel rows', JSON.stringify(hotels, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
