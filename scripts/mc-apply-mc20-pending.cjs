/**
 * Apply stuck MC-20 heal gap patch.
 * node scripts/mc-apply-mc20-pending.cjs
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { sb } = require('../api/mc/_lib');
const { patchPrimaryEvent } = require('../api/mc/gcal-write-lib');
const { getAccessToken } = require('../api/mc/gcal-lib');

const QUEUE_ID = '8f0c8ead-4cb6-4bb6-87b4-f458cf7158ff';
const EVENT_ID = '17i499adai2vcrr5f74nikrsgc';
const startIso = '2026-08-13T15:00:00.000Z';
const endIso = '2026-08-13T15:30:00.000Z';

(async () => {
  const token = await getAccessToken();
  const before = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${EVENT_ID}`,
    { headers: { Authorization: `Bearer ${token}` } },
  ).then((r) => r.json());
  console.log('before', {
    status: before.status,
    summary: before.summary,
    start: before.start,
    end: before.end,
    err: before.error,
  });

  if (before.error || before.status === 'cancelled') {
    await sb(`gcal_push_queue?id=eq.${QUEUE_ID}`, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: {
        status: 'dismissed',
        resolved_at: new Date().toISOString(),
        resolved_by: 'cursor',
        updated_at: new Date().toISOString(),
      },
    });
    console.log('dismissed — event gone');
    return;
  }

  await patchPrimaryEvent(EVENT_ID, { startIso, endIso });

  const after = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${EVENT_ID}`,
    { headers: { Authorization: `Bearer ${token}` } },
  ).then((r) => r.json());
  console.log('after', { start: after.start, end: after.end });

  await sb(`gcal_push_queue?id=eq.${QUEUE_ID}`, {
    method: 'PATCH',
    prefer: 'return=minimal',
    body: {
      status: 'applied',
      resolved_at: new Date().toISOString(),
      resolved_by: 'cursor',
      updated_at: new Date().toISOString(),
    },
  });
  console.log('queue marked applied');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
