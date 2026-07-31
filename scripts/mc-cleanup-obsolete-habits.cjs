/**
 * Delete Primary events matching obsolete Decision 2 titles.
 * node scripts/mc-cleanup-obsolete-habits.cjs
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { fetchHorizonEvents } = require('../api/mc/gcal-lib');
const { deletePrimaryEvent } = require('../api/mc/gcal-write-lib');
const { sb } = require('../api/mc/_lib');

function todayYmd() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
}

function addDaysYmd(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function shouldDelete(summary) {
  const s = String(summary || '');
  if (/Hotel bookings check \(Claude\)/i.test(s)) return true;
  if (/Decompress — after Hotel bookings check \(Claude\)/i.test(s)) return true;
  if (/Review\/Amend Course & Workshop Dates \+ check Hotel Bookings/i.test(s)) return true;
  if (/Decompress — after Review\/Amend Course & Workshop Dates \+ check Hotel Bookings/i.test(s)) {
    return true;
  }
  // Decision 3b — no visible admin decompress strips
  if (/Decompress — after Send Out Joining Details/i.test(s)) return true;
  if (/Decompress — after Review\/Amend Course & Workshop Dates$/i.test(s)) return true;
  if (/Decompress — after Hotel bookings — Alan/i.test(s)) return true;
  if (/Decompress — after Claude monthly hotel/i.test(s)) return true;
  return false;
}

(async () => {
  const today = todayYmd();
  const timeMin = `${today}T00:00:00Z`;
  const timeMax = `${addDaysYmd(today, 120)}T23:59:59Z`;
  const { events } = await fetchHorizonEvents(timeMin, timeMax);
  const targets = (events || []).filter((e) => {
    if ((e._calendarId || 'primary') !== 'primary') return false;
    return shouldDelete(e.summary);
  });
  let ok = 0;
  let fail = 0;
  for (const e of targets) {
    try {
      await deletePrimaryEvent(e.id);
      ok += 1;
      console.log('deleted', e.id, e.summary, e.start?.dateTime || e.start?.date);
    } catch (err) {
      fail += 1;
      console.log('fail', e.id, err.message);
    }
  }
  // Retire gap buffers tied to deleted decompress after Claude/old Review.
  await sb('gap_buffer_blocks?status=eq.active&after_label=ilike.*Hotel bookings check (Claude)*', {
    method: 'PATCH', prefer: 'return=minimal',
    body: { status: 'retired', updated_at: new Date().toISOString() },
  }).catch(() => {});
  await sb('gap_buffer_blocks?status=eq.active&after_label=ilike.*check Hotel Bookings*', {
    method: 'PATCH', prefer: 'return=minimal',
    body: { status: 'retired', updated_at: new Date().toISOString() },
  }).catch(() => {});
  console.log(JSON.stringify({ matched: targets.length, ok, fail }));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
