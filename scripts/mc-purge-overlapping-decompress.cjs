/** Delete MC decompress buffers that overlap other primary commitments. */
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

function overlaps(a0, a1, b0, b1) {
  return a0 < b1 && b0 < a1;
}

async function main() {
  const today = londonToday();
  const { events } = await fetchHorizonEvents(
    `${addDaysYmd(today, -7)}T00:00:00.000Z`,
    `${addDaysYmd(today, 120)}T00:00:00.000Z`,
  );
  const primary = (events || []).filter((e) => (e._calendarId || 'primary') === 'primary' && e.start?.dateTime);
  const decompress = primary.filter((e) => /MC ⏳/.test(e.summary || '') && /Decompress/i.test(e.summary || ''));
  const others = primary.filter((e) => !decompress.some((d) => d.id === e.id));
  let deleted = 0;
  for (const d of decompress) {
    const d0 = Date.parse(d.start.dateTime);
    const d1 = Date.parse(d.end?.dateTime || d.start.dateTime);
    const hit = others.find((o) => {
      if (o.transparency === 'transparent') return false;
      const o0 = Date.parse(o.start.dateTime);
      const o1 = Date.parse(o.end?.dateTime || o.start.dateTime);
      return overlaps(d0, d1, o0, o1);
    });
    if (!hit) continue;
    await deletePrimaryEvent(d.id);
    await sb(`gap_buffer_blocks?calendar_event_id=eq.${d.id}`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: { status: 'retired', calendar_event_id: null },
    }).catch(() => {});
    deleted += 1;
    console.log('deleted', d.summary, 'hit', hit.summary);
  }
  console.log(JSON.stringify({ deleted }, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
