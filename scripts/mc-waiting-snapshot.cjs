/**
 * Snapshot: stuck unplaced habits + any remaining orphan after-decompress.
 * node scripts/mc-waiting-snapshot.cjs
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { sb } = require('../api/mc/_lib');
const { fetchHorizonEvents } = require('../api/mc/gcal-lib');
const { londonToday, addDaysYmd } = require('../api/mc/diary-lib');
const { isoToLondonDate } = require('../api/mc/scheduling-rules-lib');

(async () => {
  const today = londonToday();
  const to = addDaysYmd(today, 200);
  const habits = await sb('recurring_tasks?select=id,title&active=eq.true');
  const byId = new Map((habits || []).map((h) => [h.id, h.title]));
  const logs = await sb(
    `recurring_log?ideal_date=gte.${today}&ideal_date=lte.${to}`
    + '&select=recurring_task_id,ideal_date,scheduled_date,calendar_event_id,change'
    + '&order=ideal_date.asc&limit=3000',
  );

  const stuck = [];
  for (const r of logs || []) {
    const unplaced = !r.scheduled_date || /^unplaced/i.test(r.change || '');
    const noGcal = !r.calendar_event_id;
    if (unplaced || (r.scheduled_date && noGcal && !/^skip/i.test(r.change || ''))) {
      stuck.push({
        title: byId.get(r.recurring_task_id) || r.recurring_task_id,
        ideal: r.ideal_date,
        scheduled: r.scheduled_date,
        gcal: !!r.calendar_event_id,
        change: String(r.change || '').slice(0, 50),
      });
    }
  }
  console.log('STUCK_COUNT', stuck.length);
  for (const s of stuck.slice(0, 40)) {
    console.log(`${s.ideal} | ${s.scheduled || 'null'} | ${s.gcal ? 'gcal' : 'NO'} | ${s.title} | ${s.change}`);
  }
  if (stuck.length > 40) console.log(`... +${stuck.length - 40} more`);

  const { events } = await fetchHorizonEvents(`${today}T00:00:00.000Z`, `${to}T00:00:00.000Z`);
  const primary = (events || []).filter((e) => (e._calendarId || 'primary') === 'primary' && e.start?.dateTime);
  const afterDec = primary.filter((e) => /Decompress — after /i.test(e.summary || ''));
  let orphans = 0;
  for (const d of afterDec) {
    const day = isoToLondonDate(d.start.dateTime);
    const after = (/Decompress — after (.+)$/i.exec(d.summary) || [])[1] || '';
    const ok = primary.some((e) => {
      if (e.id === d.id) return false;
      if (/Decompress|Prep —|Travel |AWAY|REST|⚽/i.test(e.summary || '')) return false;
      if (!(/^MC\b/i.test(e.summary || '') || /^P\d\s*·\s*MC-/i.test(e.summary || ''))) return false;
      if (isoToLondonDate(e.start.dateTime) !== day) return false;
      const bare = String(e.summary || '').replace(/^MC\s*[^\s]+\s+/, '').replace(/^P\d\s*·\s*MC-\d+\s*·\s*/i, '');
      const a = after.toLowerCase().slice(0, 24);
      const b = bare.toLowerCase().slice(0, 24);
      return a && b && (a.includes(b.slice(0, 16)) || b.includes(a.slice(0, 16)));
    });
    if (!ok) orphans += 1;
  }
  console.log('ORPHAN_AFTER_DECOMPRESS', orphans);
})().catch((e) => { console.error(e); process.exit(1); });
