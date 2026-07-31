/**
 * Decision 3 cleanup: delete ALL Primary "MC ⏳ Decompress — after …" that are
 * admin/habit/task gap paints — keep workshop/client travel prep+decompress.
 * node scripts/mc-purge-admin-decompress.cjs
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

/** Gap-paint orphans from syncGapBuffers — NOT travel-pipeline workshop decompress. */
function isAdminOrTaskGapDecompress(summary) {
  const s = String(summary || '');
  if (!/MC\s*⏳/i.test(s)) return false;
  // Gap painter always uses this exact phrase. Workshop Prep/Decompress use other shapes.
  return /Decompress\s*—\s*after\b/i.test(s);
}

(async () => {
  const today = todayYmd();
  const timeMin = `${addDaysYmd(today, -7)}T00:00:00Z`;
  const timeMax = `${addDaysYmd(today, 180)}T23:59:59Z`;
  const { events } = await fetchHorizonEvents(timeMin, timeMax);
  const targets = (events || []).filter((e) => {
    if ((e._calendarId || 'primary') !== 'primary') return false;
    return isAdminOrTaskGapDecompress(e.summary);
  });

  let ok = 0;
  let fail = 0;
  for (const e of targets) {
    try {
      await deletePrimaryEvent(e.id);
      ok += 1;
      console.log('deleted', e.start?.dateTime || e.start?.date, e.summary);
    } catch (err) {
      fail += 1;
      console.log('fail', e.id, err.message);
    }
  }

  // Retire all active gap_buffer_blocks (admin gap painter table)
  const active = await sb('gap_buffer_blocks?status=eq.active&select=id&limit=5000') || [];
  let retired = 0;
  for (const row of active) {
    await sb(`gap_buffer_blocks?id=eq.${row.id}`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: { status: 'retired', updated_at: new Date().toISOString() },
    });
    retired += 1;
  }

  // Verify none left on Primary in horizon
  const { events: after } = await fetchHorizonEvents(timeMin, timeMax);
  const left = (after || []).filter((e) => {
    if ((e._calendarId || 'primary') !== 'primary') return false;
    return isAdminOrTaskGapDecompress(e.summary);
  });

  const stillActive = await sb('gap_buffer_blocks?status=eq.active&select=id&limit=5') || [];

  console.log(JSON.stringify({
    matched: targets.length,
    deleted: ok,
    fail,
    gap_rows_retired: retired,
    remaining_gcal: left.length,
    remaining_db_active: stillActive.length,
    remaining_titles: left.slice(0, 10).map((e) => e.summary),
  }, null, 2));

  if (left.length || stillActive.length || fail) process.exit(1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
