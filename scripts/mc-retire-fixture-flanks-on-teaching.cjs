/**
 * Delete MC ⚽ Before/After flanks that overlap a live workshop/tuition event.
 * node scripts/mc-retire-fixture-flanks-on-teaching.cjs
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { sb } = require('../api/mc/_lib');
const { fetchHorizonEvents } = require('../api/mc/gcal-lib');
const { deletePrimaryEvent } = require('../api/mc/gcal-write-lib');
const { londonToday, addDaysYmd } = require('../api/mc/diary-lib');
const { isoToLondonDate } = require('../api/mc/scheduling-rules-lib');

function overlaps(a0, a1, b0, b1) {
  return a0 < b1 && b0 < a1;
}

async function main() {
  const today = londonToday();
  const { events } = await fetchHorizonEvents(
    `${addDaysYmd(today, -7)}T00:00:00.000Z`,
    `${addDaysYmd(today, 280)}T00:00:00.000Z`,
  );
  const flanks = (events || []).filter((e) => /^MC\s*⚽\s*(Before|After):/u.test(e.summary || '') && e.start?.dateTime);
  const teach = (events || []).filter((e) => {
    const t = e.summary || '';
    if (/^MC\b/i.test(t)) return false;
    const cal = String(e._calendarId || '');
    return cal.includes('ic364d06') || cal.includes('nht93uaq')
      || /workshop|masterclass|tuition|1-2-1/i.test(t);
  });
  let deleted = 0;
  for (const f of flanks) {
    const f0 = Date.parse(f.start.dateTime);
    const f1 = Date.parse(f.end?.dateTime || f.start.dateTime);
    const hit = teach.find((t) => {
      if (t.start?.date && !t.start?.dateTime) {
        const day = isoToLondonDate(f.start.dateTime);
        const end = t.end?.date || t.start.date;
        return day >= t.start.date && day < end;
      }
      if (!t.start?.dateTime) return false;
      const t0 = Date.parse(t.start.dateTime);
      const t1 = Date.parse(t.end?.dateTime || t.start.dateTime);
      return overlaps(f0, f1, t0, t1);
    });
    if (!hit) continue;
    await deletePrimaryEvent(f.id);
    await sb(`fixture_blocks?or=(before_event_id.eq.${f.id},after_event_id.eq.${f.id})`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: { before_event_id: null, after_event_id: null },
    }).catch(() => {});
    deleted += 1;
    console.log('deleted', f.summary, 'vs', hit.summary);
  }
  console.log(JSON.stringify({ deleted, flanks: flanks.length }, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
