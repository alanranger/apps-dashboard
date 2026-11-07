/**
 * Align GCal with Mission Control for this week's done-item mess.
 * node scripts/mc-align-week-match.cjs
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { sb } = require('../api/mc/_lib');
const { patchPrimaryEvent, deletePrimaryEvent, insertPrimaryEvent } = require('../api/mc/gcal-write-lib');
const { habitGcalTitle } = require('../api/mc/gcal-title-lib');

(async () => {
  // Hartland after White Horse (no overlap)
  await patchPrimaryEvent('jnk10hibaa3q05ihrg8k9se0gk', {
    summary: 'DONE · MC ⏰ Room release — Hartland Quay Hotel, Bideford EX39 6DB',
    startIso: '2026-07-28T12:52:25.564Z',
    endIso: '2026-07-28T13:12:25.564Z',
  });
  console.log('Hartland after White Horse ok');

  // Friday Hotel bookings completed → today
  const habitEvt = '4okdhb83vblpkjkv7d3i9h45pk';
  const logs = await sb(
    `recurring_log?calendar_event_id=eq.${habitEvt}&select=id,recurring_task_id,change,at&order=at.desc&limit=1`,
  );
  const log = logs?.[0];
  const habit = log
    ? (await sb(`recurring_tasks?id=eq.${log.recurring_task_id}&select=id,title`))?.[0]
    : null;
  const mins = 10;
  const startIso = new Date().toISOString();
  const endIso = new Date(Date.now() + mins * 60000).toISOString();
  const title = habitGcalTitle(habit?.title || 'Hotel bookings — Alan actions');

  const friGaps = await sb(
    "gap_buffer_blocks?day=eq.2026-07-31&status=eq.active&select=id,calendar_event_id,after_label",
  );
  for (const row of friGaps || []) {
    if (/Hotel bookings — Alan/i.test(row.after_label || '')) {
      if (row.calendar_event_id) {
        try { await deletePrimaryEvent(row.calendar_event_id); } catch (_) { /* ignore */ }
      }
      await sb(`gap_buffer_blocks?id=eq.${row.id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: { status: 'retired', calendar_event_id: null, updated_at: new Date().toISOString() },
      });
      console.log('retired fri gap', row.id);
    }
  }

  let liveId = habitEvt;
  try {
    await patchPrimaryEvent(habitEvt, { summary: title, startIso, endIso });
  } catch (e) {
    console.log('patch failed', e.message);
    try { await deletePrimaryEvent(habitEvt); } catch (_) { /* ignore */ }
    liveId = (await insertPrimaryEvent({ summary: title, startIso, endIso })).id;
  }
  console.log('Hotel bookings on today', liveId, startIso);

  if (log?.id) {
    await sb(`recurring_log?id=eq.${log.id}`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: {
        change: `completed 2026-07-28|actual=${mins}|at=${startIso}`,
        calendar_event_id: liveId,
        roll_reason: 'align_week_match',
      },
    });
  }
  if (habit?.id) {
    await sb(`recurring_tasks?id=eq.${habit.id}`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: { last_done: '2026-07-28', updated_at: new Date().toISOString() },
    });
  }
  console.log('done');
})().catch((e) => { console.error(e); process.exit(1); });
