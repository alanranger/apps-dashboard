/**
 * One-shot: skip Backup Photos ideal 2026-08-24 (rolled to 25th) + delete GCal.
 * Prior Skip Next hit wrong-phase 2026-09-28.
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { sb } = require('../api/mc/_lib');
const {
  relatedIdForHabit, upsertPushRow, supersedeSiblingHabitRows,
} = require('../api/mc/gcal-push-lib');
const { autoSyncIfAllowed } = require('../api/mc/gcal-auto-sync-lib');
const { retireGapBuffersAfter } = require('../api/mc/buffer-gap-lib');

(async () => {
  const id = '38fe0fbd-3eb6-41df-9480-a862d5104cef';
  const occurrenceDate = '2026-08-24';
  const logId = 'a57b4351-b55e-42d7-ba5e-a77ae4d55a7c';
  const evtId = 'b71bohml2qcrdfqkmar4k0tshk';
  const title = 'Backup Photos to Portable Drive';
  const note = 'skipped occurrence 2026-08-24: not required (heal after wrong-phase Skip Next)';

  await sb(`recurring_log?id=eq.${logId}`, {
    method: 'PATCH', prefer: 'return=minimal',
    body: {
      change: note,
      ideal_date: occurrenceDate,
      scheduled_date: '2026-08-25',
      calendar_event_id: evtId,
      roll_reason: 'recurring_skip_next',
      at: new Date().toISOString(),
    },
  });
  await sb(`recurring_tasks?id=eq.${id}`, {
    method: 'PATCH', prefer: 'return=minimal',
    body: { updated_at: new Date().toISOString() },
  });

  await retireGapBuffersAfter(sb, upsertPushRow, {
    afterEventId: evtId,
    labelHints: [title],
  });

  const related = relatedIdForHabit(id, occurrenceDate, evtId);
  await upsertPushRow(sb, {
    related_id: related,
    entity_type: 'habit',
    change_kind: 'skip',
    summary: `Skip next (heal): ${title} (${occurrenceDate})`,
    proposed_action: `Delete/cancel GCal event ${evtId} for this occurrence only`,
    payload: {
      habit_id: id,
      ideal_date: occurrenceDate,
      scheduled_date: '2026-08-25',
      calendar_event_id: evtId,
      action: 'delete_event',
    },
  });
  await supersedeSiblingHabitRows(sb, {
    habitId: id,
    keepRelatedId: related,
    calendarEventId: evtId,
    idealDate: occurrenceDate,
    scheduledDate: '2026-08-25',
    actor: 'cursor-heal-skip',
  });

  const sync = await autoSyncIfAllowed(sb, 'cursor-heal-skip');
  console.log(JSON.stringify({
    skipped: occurrenceDate,
    evtId,
    sync_skipped: !!sync.skipped,
    applied: sync.flush?.applied ?? 0,
    failed: sync.flush?.failed ?? 0,
    reason: sync.reason || sync.error || null,
  }, null, 2));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
