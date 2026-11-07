/**
 * Repair: White Horse MC-32 done slot on GCal; Hartland room-release → today.
 * node scripts/mc-repair-done-slots.cjs
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { sb } = require('../api/mc/_lib');
const { insertPrimaryEvent, patchPrimaryEvent, deletePrimaryEvent } = require('../api/mc/gcal-write-lib');
const { taskGcalTitle } = require('../api/mc/gcal-title-lib');
const { retireGapBuffersAfter } = require('../api/mc/buffer-gap-lib');
const { upsertPushRow } = require('../api/mc/gcal-push-lib');

(async () => {
  // --- MC-32 White Horse: recreate at completion slot ---
  const task = (await sb(
    'tasks?display_id=eq.32&select=id,display_id,title,priority,state,scheduled_start,scheduled_end,calendar_event_id,actual_minutes,completed_on',
  ))?.[0];
  if (!task) throw new Error('MC-32 missing');
  console.log('MC-32 before', task);
  const title = taskGcalTitle(task);
  const startIso = new Date(task.scheduled_start).toISOString();
  const endIso = new Date(task.scheduled_end).toISOString();
  let evtId = task.calendar_event_id;
  if (evtId) {
    try {
      await patchPrimaryEvent(evtId, { summary: title, startIso, endIso });
      console.log('MC-32 patched', evtId);
    } catch (e) {
      console.log('MC-32 patch failed, inserting', e.message);
      evtId = null;
    }
  }
  if (!evtId) {
    const created = await insertPrimaryEvent({ summary: title, startIso, endIso });
    evtId = created.id;
    console.log('MC-32 inserted', evtId);
  }
  await sb(`tasks?id=eq.${task.id}`, {
    method: 'PATCH', prefer: 'return=minimal',
    body: { calendar_event_id: evtId },
  });
  await retireGapBuffersAfter(sb, upsertPushRow, {
    afterEventId: '25crskamj3a56melavn380usa4',
    labelHints: ['MC-32', 'White Horse'],
  });

  // --- Hartland room release: move to now (done today) ---
  const hotelId = 'dc14064e-c243-408a-9d36-fa8e4816c7fa';
  const hotelEvt = 'jnk10hibaa3q05ihrg8k9se0gk';
  const hotel = (await sb(
    `workshop_hotels?id=eq.${hotelId}&select=id,hotel,workshop_name,notes,reminder_event_id`,
  ))?.[0];
  const now = new Date();
  const hStart = now.toISOString();
  const hEnd = new Date(now.getTime() + 20 * 60000).toISOString();
  const hTitle = `DONE · MC ⏰ Room release — ${hotel.hotel || 'Hartland Quay'}`;
  await retireGapBuffersAfter(sb, upsertPushRow, {
    afterEventId: hotelEvt,
    labelHints: ['Room release', 'Hartland'],
  });
  try {
    await patchPrimaryEvent(hotelEvt, { summary: hTitle, startIso: hStart, endIso: hEnd });
    console.log('Hartland moved to today', hStart);
  } catch (e) {
    console.log('Hartland patch failed', e.message);
    try { await deletePrimaryEvent(hotelEvt); } catch (_) { /* ignore */ }
    const created = await insertPrimaryEvent({ summary: hTitle, startIso: hStart, endIso: hEnd });
    console.log('Hartland recreated', created.id);
  }
  const noteLine = `done ${hStart.slice(0, 10)} via diary repair @ ${hStart}`;
  await sb(`workshop_hotels?id=eq.${hotelId}`, {
    method: 'PATCH', prefer: 'return=minimal',
    body: {
      reminder_event_id: null,
      reminder_placed: false,
      notes: hotel.notes ? `${hotel.notes}\n${noteLine}` : noteLine,
      updated_at: new Date().toISOString(),
    },
  });

  // Flush any queued decompress deletes
  const { pushSync } = require('../api/mc/gcal-auto-sync-lib');
  await sb(`scheduling_rules?key=eq.${encodeURIComponent('gcal_push_inflight_until')}`, {
    method: 'PATCH', prefer: 'return=minimal',
    body: { value: '0', updated_at: new Date().toISOString() },
  }).catch(() => {});
  const flush = await pushSync(sb, 'repair-done-slots', { includeBacklog: false, includeRuleMasters: false });
  console.log('flush', {
    planned: flush.flush?.planned,
    applied: flush.flush?.applied,
    failed: flush.flush?.failed,
  });
  console.log('done');
})().catch((e) => { console.error(e); process.exit(1); });
