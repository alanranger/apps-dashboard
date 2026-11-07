const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { insertPrimaryEvent } = require('../api/mc/gcal-write-lib');
const { sb } = require('../api/mc/_lib');

(async () => {
  const startIso = '2026-07-28T12:46:37.242Z';
  const endIso = '2026-07-28T12:56:37.242Z';
  const created = await insertPrimaryEvent({
    summary: 'MC 🔁 Hotel bookings — Alan actions',
    startIso,
    endIso,
  });
  console.log('created', created.id, created.status);
  await sb('recurring_log?id=eq.4946b9bf-23a5-4c1b-883e-904740ae0b11', {
    method: 'PATCH', prefer: 'return=minimal',
    body: {
      calendar_event_id: created.id,
      change: `completed 2026-07-28|actual=10|at=${startIso}`,
    },
  });
  console.log('ok');
})().catch((e) => { console.error(e); process.exit(1); });
