const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
for (const line of fs.readFileSync(path.join(root, '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { sb } = require('../api/mc/_lib.js');
const { patchPrimaryEvent, deletePrimaryEvent } = require('../api/mc/gcal-write-lib.js');

(async () => {
  await sb('recurring_log?id=eq.38fd818b-c7fd-4059-bb21-163132aacd8c', {
    method: 'PATCH', prefer: 'return=minimal',
    body: {
      change: 'skipped superseded_by_deconflict_pin:a613c9fa-249b-413e-bea5-bda90658758e',
      calendar_event_id: null,
      roll_reason: 'reconcile_dedupe_event',
    },
  });
  await patchPrimaryEvent('gm6fv4pe5iqhen9g4kc1t8kq9k', {
    startIso: '2026-08-10T16:15:00.000Z',
    endIso: '2026-08-10T18:15:00.000Z',
    summary: 'MC 🔁 Publish Blog Post',
  });
  console.log('blog event owned by Aug 10 pin');

  const orphan = '0np73n7k18621lhm2qo093j3nk';
  const logs = await sb(`recurring_log?calendar_event_id=eq.${orphan}&select=id,scheduled_date,ideal_date,change`);
  const day = await sb(
    'recurring_log?recurring_task_id=eq.0a7aa275-b148-4364-a184-fc14daea8edb'
    + '&scheduled_date=eq.2026-09-17'
    + '&select=id,ideal_date,scheduled_date,calendar_event_id,change,roll_reason',
  );
  console.log('orphan logs', logs);
  console.log('sep17 logs', day);
  if (!(logs || []).length) {
    try {
      await deletePrimaryEvent(orphan);
      console.log('deleted unreferenced orphan', orphan);
    } catch (e) {
      console.log('delete orphan', e.message);
    }
  } else {
    // Prefer pin if present on same day; else leave
    const pin = (day || []).find((l) => String(l.change || '').startsWith('diary_pin:'));
    if (pin && pin.calendar_event_id && pin.calendar_event_id !== orphan) {
      await deletePrimaryEvent(orphan);
      for (const l of logs) {
        await sb(`recurring_log?id=eq.${l.id}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: {
            change: `skipped duplicate_event_of:${pin.id}`,
            calendar_event_id: null,
            roll_reason: 'reconcile_dedupe_event',
          },
        });
      }
      console.log('removed stale sep17 event; kept pin', pin.calendar_event_id);
    }
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
