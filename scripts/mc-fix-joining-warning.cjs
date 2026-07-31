/**
 * Fix Aug 7 Joining ghost (15m warning mis-titled) + check near Joining days.
 * node scripts/mc-fix-joining-warning.cjs
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { deletePrimaryEvent, insertPrimaryEvent } = require('../api/mc/gcal-write-lib');

(async () => {
  // Mis-titled 15m slot that should be the UNSCHEDULED warning
  await deletePrimaryEvent('5h3qte2hn92qa7p5t36q85lvp4');
  await insertPrimaryEvent({
    summary: 'MC ⚠️ UNSCHEDULED: Send Out Joining Details',
    startIso: '2026-08-07T19:00:00.000Z',
    endIso: '2026-08-07T19:15:00.000Z',
  });
  // Wed 9 Sep Joining is outside Fri/Thu window — delete; placer/alert owns it
  await deletePrimaryEvent('m6k1salaknhhl0etcitbevqp74');
  console.log('fixed Aug7 warning + removed Wed Sep9 Joining');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
