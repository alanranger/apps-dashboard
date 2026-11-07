const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { patchPrimaryEvent } = require('../api/mc/gcal-write-lib');
(async () => {
  // Re-apply pinned MC-8 slot (flush said applied but GCal stayed at 10:00)
  await patchPrimaryEvent('6379fs6p2tjhg5knmrbgosckao', {
    summary: 'P1 · MC-8 · Rev-weighting brief',
    startIso: '2026-08-11T15:30:00.000Z',
    endIso: '2026-08-11T18:00:00.000Z',
  });
  console.log('MC-8 patched to 16:30–19:00 London');
})().catch((e) => { console.error(e); process.exit(1); });
