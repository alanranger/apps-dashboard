const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '..', '.env.local');
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { sb } = require('../api/mc/_lib');
const { patchPrimaryEvent, verifyPrimaryEvent } = require('../api/mc/gcal-write-lib');

(async () => {
  const evt = 'o87oav3g9ni4m9rje0gttfvc88';
  const startIso = '2026-08-06T16:00:00.000Z';
  const endIso = '2026-08-06T19:30:00.000Z';
  await patchPrimaryEvent(evt, { startIso, endIso });
  const v = await verifyPrimaryEvent(evt, { startIso, endIso });
  console.log('verify', v);
  if (!v.ok) process.exit(1);
  await sb('pending_diary_changes?id=eq.e2b35da2-748a-444f-8a7a-031bb9574f95', {
    method: 'PATCH', prefer: 'return=minimal',
    body: {
      status: 'applied',
      resolved_at: new Date().toISOString(),
      resolved_by: 'cursor',
    },
  });
  console.log('marked travel_back_fix applied');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
