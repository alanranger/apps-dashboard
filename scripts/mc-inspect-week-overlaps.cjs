/**
 * Inspect overlaps for week 27 Jul – 2 Aug 2026.
 * node scripts/mc-inspect-week-overlaps.cjs
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { fetchHorizonEvents } = require('../api/mc/gcal-lib');
const { isoToLondonDate, isoToLondonMinutes } = require('../api/mc/scheduling-rules-lib');

function overlaps(a0, a1, b0, b1) {
  return a0 < b1 && b0 < a1;
}

(async () => {
  const { events } = await fetchHorizonEvents(
    '2026-07-27T00:00:00.000Z',
    '2026-08-03T00:00:00.000Z',
  );
  const timed = (events || []).filter((e) => e.start?.dateTime)
    .sort((a, b) => a.start.dateTime.localeCompare(b.start.dateTime));

  console.log('=== ALL timed events ===');
  for (const e of timed) {
    const day = isoToLondonDate(e.start.dateTime);
    const t0 = e.start.dateTime.slice(11, 16);
    const t1 = (e.end?.dateTime || e.start.dateTime).slice(11, 16);
    const cal = (e._calendarId || 'primary').slice(0, 14);
    console.log(`${day} ${t0}-${t1} [${cal}] ${(e.summary || '').slice(0, 90)}`);
  }

  const primary = timed.filter((e) => (e._calendarId || 'primary') === 'primary');
  console.log('\n=== PRIMARY overlaps (MC vs anything primary) ===');
  let n = 0;
  for (let i = 0; i < primary.length; i += 1) {
    const a = primary[i];
    const a0 = Date.parse(a.start.dateTime);
    const a1 = Date.parse(a.end?.dateTime || a.start.dateTime);
    for (let j = i + 1; j < primary.length; j += 1) {
      const b = primary[j];
      if (isoToLondonDate(a.start.dateTime) !== isoToLondonDate(b.start.dateTime)) continue;
      const b0 = Date.parse(b.start.dateTime);
      const b1 = Date.parse(b.end?.dateTime || b.start.dateTime);
      if (!overlaps(a0, a1, b0, b1)) continue;
      n += 1;
      console.log(
        'OVERLAP',
        isoToLondonDate(a.start.dateTime),
        `${a.start.dateTime.slice(11, 16)}-${(a.end?.dateTime || '').slice(11, 16)}`,
        (a.summary || '').slice(0, 45),
        '×',
        `${b.start.dateTime.slice(11, 16)}-${(b.end?.dateTime || '').slice(11, 16)}`,
        (b.summary || '').slice(0, 45),
      );
    }
  }
  console.log('overlap_pairs', n);

  // Decompress that overlaps its parent or other MC work
  console.log('\n=== Decompress overlapping MC work ===');
  const decomps = primary.filter((e) => /Decompress/i.test(e.summary || ''));
  const work = primary.filter((e) => {
    const t = e.summary || '';
    if (/Decompress|Prep —|Travel |AWAY|REST|⚽/i.test(t)) return false;
    return /^MC\b/i.test(t) || /^P\d\s*·\s*MC-/i.test(t);
  });
  for (const d of decomps) {
    const d0 = Date.parse(d.start.dateTime);
    const d1 = Date.parse(d.end?.dateTime || d.start.dateTime);
    for (const w of work) {
      if (isoToLondonDate(d.start.dateTime) !== isoToLondonDate(w.start.dateTime)) continue;
      const w0 = Date.parse(w.start.dateTime);
      const w1 = Date.parse(w.end?.dateTime || w.start.dateTime);
      if (!overlaps(d0, d1, w0, w1)) continue;
      console.log(
        'DECOMP_OVER_WORK',
        isoToLondonDate(d.start.dateTime),
        (d.summary || '').slice(0, 50),
        '×',
        (w.summary || '').slice(0, 50),
      );
    }
  }

  // Same title same day
  console.log('\n=== Exact title+day dupes ===');
  const by = new Map();
  for (const e of primary) {
    const k = `${isoToLondonDate(e.start.dateTime)}|${e.summary}`;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(e);
  }
  for (const [k, g] of by) {
    if (g.length > 1) console.log('DUP', g.length, k.slice(0, 100));
  }
})().catch((e) => { console.error(e); process.exit(1); });
