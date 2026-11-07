/**
 * Probe why Light & Logic is unplaced Aug–Dec + hotel schema.
 * node scripts/mc-probe-ll-unplaced.cjs
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
  const days = ['2026-08-15', '2026-09-15', '2026-10-15', '2026-11-15', '2026-12-15'];
  for (const day of days) {
    const next = new Date(Date.parse(`${day}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
    const { events } = await fetchHorizonEvents(`${day}T00:00:00.000Z`, `${next}T00:00:00.000Z`);
    console.log(`\n=== ${day} ===`);
    for (const e of (events || []).filter((x) => x.start?.dateTime || x.start?.date)
      .sort((a, b) => String(a.start.dateTime || a.start.date)
        .localeCompare(String(b.start.dateTime || b.start.date)))) {
      const t = e.start.dateTime ? e.start.dateTime.slice(11, 16) : 'allday';
      const d = e.start.dateTime ? isoToLondonDate(e.start.dateTime) : e.start.date;
      if (d !== day) continue;
      console.log(t, (e._calendarId || 'primary').slice(0, 14), String(e.summary || '').slice(0, 90));
    }
  }

  const sample = await sb('workshop_hotels?select=*&limit=1');
  console.log('\nworkshop_hotels columns', Object.keys(sample?.[0] || {}));

  const logs = await sb(
    'recurring_log?recurring_task_id=eq.c2f135c9-7146-415d-8231-c2460a064e94'
    + '&select=ideal_date,scheduled_date,calendar_event_id,change,created_at,updated_at'
    + '&order=ideal_date.asc',
  );
  console.log('\nAll LL logs:');
  for (const r of logs || []) {
    console.log(r.ideal_date, '->', r.scheduled_date, (r.change || '').slice(0, 90));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
