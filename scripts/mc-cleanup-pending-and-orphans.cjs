/**
 * Cleanup after diary↔GCal reconcile:
 * 1) Dismiss stale pending_diary_changes (keep hotel_* rows)
 * 2) Delete orphan "Decompress — after …" Primary events + retire gap rows
 * 3) Clear Nov 18 Upload sites stuck unplaced log
 *
 * node scripts/mc-cleanup-pending-and-orphans.cjs
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

const ACTOR = 'cursor-cleanup-2026-07-28';
const KEEP_TYPES = new Set([
  'hotel_booking_unregistered',
  'hotel_row_unconfirmed',
  'hotel_cancelled_but_registered',
  'hotel_deadline',
  'missing_travel_block',
]);

async function dismissPending() {
  const pending = await sb(
    'pending_diary_changes?status=eq.pending&select=id,change_type,summary&order=detected_at.asc&limit=2000',
  ) || [];
  const keep = [];
  const drop = [];
  for (const row of pending) {
    if (KEEP_TYPES.has(row.change_type)) keep.push(row);
    else drop.push(row);
  }
  const now = new Date().toISOString();
  let dismissed = 0;
  // Patch in chunks of 50 ids
  for (let i = 0; i < drop.length; i += 50) {
    const chunk = drop.slice(i, i + 50);
    const ids = chunk.map((r) => r.id).join(',');
    await sb(`pending_diary_changes?id=in.(${ids})`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: {
        status: 'dismissed',
        resolved_at: now,
        resolved_by: ACTOR,
      },
    });
    dismissed += chunk.length;
  }
  return {
    total_pending_before: pending.length,
    dismissed,
    kept: keep.map((r) => ({ type: r.change_type, summary: r.summary })),
  };
}

async function purgeOrphanDecompress() {
  const today = londonToday();
  const to = addDaysYmd(today, 200);
  const { events } = await fetchHorizonEvents(`${today}T00:00:00.000Z`, `${to}T00:00:00.000Z`);
  const primary = (events || []).filter((e) => (e._calendarId || 'primary') === 'primary' && e.start?.dateTime);
  const afterDec = primary.filter((e) => /Decompress — after /i.test(e.summary || ''));
  const deleted = [];
  for (const d of afterDec) {
    const day = isoToLondonDate(d.start.dateTime);
    const after = (/Decompress — after (.+)$/i.exec(d.summary) || [])[1] || '';
    const ok = primary.some((e) => {
      if (e.id === d.id) return false;
      if (/Decompress|Prep —|Travel |AWAY|REST|⚽/i.test(e.summary || '')) return false;
      if (!(/^MC\b/i.test(e.summary || '') || /^P\d\s*·\s*MC-/i.test(e.summary || '') || /^DONE\b/i.test(e.summary || ''))) {
        return false;
      }
      if (isoToLondonDate(e.start.dateTime) !== day) return false;
      const bare = String(e.summary || '')
        .replace(/^DONE\s*[·•\-–]\s*/i, '')
        .replace(/^MC\s*[^\s]+\s+/, '')
        .replace(/^P\d\s*·\s*MC-\d+\s*·\s*/i, '');
      const a = after.toLowerCase().slice(0, 24);
      const b = bare.toLowerCase().slice(0, 24);
      return a && b && (a.includes(b.slice(0, 16)) || b.includes(a.slice(0, 16)));
    });
    if (ok) continue;
    try {
      await deletePrimaryEvent(d.id);
      deleted.push({ id: d.id, summary: d.summary, day });
    } catch (e) {
      deleted.push({ id: d.id, summary: d.summary, day, error: e.message });
    }
    await sb(
      `gap_buffer_blocks?calendar_event_id=eq.${encodeURIComponent(d.id)}`,
      {
        method: 'PATCH', prefer: 'return=minimal',
        body: { status: 'retired', calendar_event_id: null, updated_at: new Date().toISOString() },
      },
    ).catch(() => {});
  }
  return { scanned: afterDec.length, deleted: deleted.length, rows: deleted };
}

async function clearNovUploadSites() {
  const habit = (await sb(
    "recurring_tasks?title=ilike.*Upload sites*&select=id,title,active",
  ))?.[0];
  if (!habit) return { ok: false, reason: 'habit_not_found' };
  const logs = await sb(
    `recurring_log?recurring_task_id=eq.${habit.id}&ideal_date=eq.2026-11-18`
    + '&select=id,ideal_date,scheduled_date,change,calendar_event_id&order=at.desc&limit=5',
  ) || [];
  let cleared = 0;
  for (const log of logs) {
    if (!/^unplaced/i.test(log.change || '') && log.scheduled_date) continue;
    await sb(`recurring_log?id=eq.${log.id}`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: {
        change: 'skipped 2026-11-18|cleanup_no_slot',
        roll_reason: 'cleanup_unplaced',
        scheduled_date: '2026-11-18',
      },
    });
    cleared += 1;
  }
  return { habit: habit.title, logs: logs.length, cleared };
}

(async () => {
  console.log('1) dismiss pending…');
  const pending = await dismissPending();
  console.log(JSON.stringify(pending, null, 2));

  console.log('2) purge orphan decompress…');
  const orphans = await purgeOrphanDecompress();
  console.log(JSON.stringify({ scanned: orphans.scanned, deleted: orphans.deleted, sample: orphans.rows.slice(0, 15) }, null, 2));

  console.log('3) clear Nov Upload sites unplaced…');
  const nov = await clearNovUploadSites();
  console.log(JSON.stringify(nov, null, 2));

  const left = await sb('pending_diary_changes?status=eq.pending&select=id,change_type');
  console.log('pending_left', (left || []).length, (left || []).map((r) => r.change_type));
})().catch((e) => { console.error(e); process.exit(1); });
