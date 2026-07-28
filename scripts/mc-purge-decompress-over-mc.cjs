/**
 * Delete MC ⏳ Decompress that overlaps another primary MC habit/task
 * (decompress must never share a slot with its parent or sibling work).
 * node scripts/mc-purge-decompress-over-mc.cjs
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
    `${addDaysYmd(today, 220)}T00:00:00.000Z`,
  );
  const primary = (events || []).filter((e) => (e._calendarId || 'primary') === 'primary' && e.start?.dateTime);
  const decomps = primary.filter((e) => /MC\s*⏳/i.test(e.summary || '') && /Decompress/i.test(e.summary || ''));
  const work = primary.filter((e) => {
    const t = e.summary || '';
    if (/MC\s*⏳/i.test(t) && /Decompress|Prep —/i.test(t)) return false;
    if (/MC\s*🚗|MC\s*⚽|MC\s*🚫|MC\s*🛌/i.test(t)) return false;
    return /MC\s/i.test(t);
  });
  let deleted = 0;
  for (const d of decomps) {
    const d0 = Date.parse(d.start.dateTime);
    const d1 = Date.parse(d.end?.dateTime || d.start.dateTime);
    const hit = work.find((w) => {
      const w0 = Date.parse(w.start.dateTime);
      const w1 = Date.parse(w.end?.dateTime || w.start.dateTime);
      return overlaps(d0, d1, w0, w1);
    });
    if (!hit) continue;
    await deletePrimaryEvent(d.id);
    await sb(
      `gap_buffer_blocks?calendar_event_id=eq.${encodeURIComponent(d.id)}`,
      {
        method: 'PATCH', prefer: 'return=minimal',
        body: { status: 'retired', calendar_event_id: null, updated_at: new Date().toISOString() },
      },
    ).catch(() => {});
    deleted += 1;
    console.log(
      'deleted',
      isoToLondonDate(d.start.dateTime),
      (d.summary || '').slice(0, 50),
      'vs',
      (hit.summary || '').slice(0, 40),
    );
  }
  console.log(JSON.stringify({ deleted, decomps: decomps.length }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
