/**
 * Delete Primary events for Decision 1 cleared project tasks.
 * node scripts/mc-delete-task-events.cjs
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { deletePrimaryEvent } = require('../api/mc/gcal-write-lib');
const { sb } = require('../api/mc/_lib');

(async () => {
  const rows = await sb(
    "gcal_push_queue?status=eq.pending&summary=ilike.*Decision 1*&select=id,payload,summary&limit=100",
  );
  let ok = 0;
  let fail = 0;
  for (const row of rows || []) {
    const evt = row.payload?.calendar_event_id;
    if (!evt) continue;
    try {
      await deletePrimaryEvent(evt);
      await sb(`gcal_push_queue?id=eq.${row.id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: { status: 'applied', resolved_at: new Date().toISOString(), resolved_by: 'mc-delete-task-events' },
      });
      ok += 1;
      console.log('deleted', evt);
    } catch (e) {
      fail += 1;
      console.log('fail', evt, e.message);
      if (e.status === 404 || /missing/i.test(e.message || '')) {
        await sb(`gcal_push_queue?id=eq.${row.id}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: { status: 'applied', resolved_at: new Date().toISOString(), resolved_by: 'mc-delete-task-events-missing' },
        }).catch(() => {});
      }
    }
  }
  console.log(JSON.stringify({ ok, fail, queued: (rows || []).length }));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
