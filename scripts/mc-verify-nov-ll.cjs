/**
 * Final verify: Nov week + LL + hotel deadlines.
 * node scripts/mc-verify-nov-ll.cjs
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

(async () => {
  const { events } = await fetchHorizonEvents('2026-08-01T00:00:00.000Z', '2027-02-01T00:00:00.000Z');
  const primary = (events || []).filter((e) => (e._calendarId || 'primary') === 'primary' && e.start?.dateTime);

  console.log('=== Light & Logic ===');
  for (const e of primary.filter((x) => /Light\s*&\s*Logic|newsletter issue/i.test(x.summary || ''))
    .sort((a, b) => a.start.dateTime.localeCompare(b.start.dateTime))) {
    console.log(isoToLondonDate(e.start.dateTime), e.start.dateTime.slice(11, 16), e.summary);
  }

  console.log('\n=== Nov 9-15 MC ===');
  for (const e of primary.filter((x) => {
    const d = isoToLondonDate(x.start.dateTime);
    return d >= '2026-11-09' && d <= '2026-11-15' && /MC\s/i.test(x.summary || '');
  }).sort((a, b) => a.start.dateTime.localeCompare(b.start.dateTime))) {
    console.log(isoToLondonDate(e.start.dateTime), e.start.dateTime.slice(11, 16), e.summary.slice(0, 85));
  }

  const decomps = primary.filter((e) => /MC\s*⏳/i.test(e.summary || '') && /Decompress — after /i.test(e.summary || ''));
  let orphans = 0;
  for (const d of decomps) {
    const day = isoToLondonDate(d.start.dateTime);
    const after = (/Decompress — after (.+)$/i.exec(d.summary) || [])[1] || '';
    const parent = primary.some((e) => {
      if (e.id === d.id) return false;
      if (/Decompress|Prep —|Travel |AWAY|REST|⚽/i.test(e.summary || '')) return false;
      if (!(/^MC\b/i.test(e.summary || '') || /^P\d\s*·\s*MC-/i.test(e.summary || ''))) return false;
      if (isoToLondonDate(e.start.dateTime) !== day) return false;
      const bare = String(e.summary || '').replace(/^MC\s*[^\s]+\s+/, '').replace(/^P\d\s*·\s*MC-\d+\s*·\s*/i, '');
      const a = after.toLowerCase().slice(0, 28);
      const b = bare.toLowerCase().slice(0, 28);
      return a && b && (a.includes(b.slice(0, 18)) || b.includes(a.slice(0, 18)));
    });
    if (!parent) orphans += 1;
  }
  console.log('\norphan_after_decompress_count', orphans);

  const wh = primary.filter((e) => /White Horse|OVERSTRAND/i.test(e.summary || '') && /Hotel deadline/i.test(e.summary || ''));
  console.log('white_horse_deadlines', wh.length, wh.map((e) => isoToLondonDate(e.start.dateTime)));

  const logs = await sb('recurring_log?recurring_task_id=eq.c2f135c9-7146-415d-8231-c2460a064e94&select=ideal_date,scheduled_date,calendar_event_id,change&order=ideal_date.asc');
  console.log('\nLL logs');
  for (const r of logs || []) {
    console.log(r.ideal_date, '->', r.scheduled_date, r.calendar_event_id ? 'gcal' : 'NO', (r.change || '').slice(0, 40));
  }
})().catch((e) => { console.error(e); process.exit(1); });
