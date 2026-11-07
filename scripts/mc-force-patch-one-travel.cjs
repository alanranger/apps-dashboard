const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { patchPrimaryEvent, getPrimaryEvent, verifyPrimaryEvent } = require('../api/mc/gcal-write-lib');

(async () => {
  const id = 'cdmc6om6pgio7cb2mck3goa23s';
  const startIso = '2026-10-31T15:30:00.000Z';
  const endIso = '2026-10-31T16:30:00.000Z';
  const p = await patchPrimaryEvent(id, { startIso, endIso });
  console.log('patch returned', JSON.stringify(p.start), JSON.stringify(p.end));
  console.log('verify', await verifyPrimaryEvent(id, { startIso, endIso }));
  const g = await getPrimaryEvent(id);
  console.log('get', JSON.stringify(g.start), JSON.stringify(g.end));
})().catch((e) => { console.error(e); process.exit(1); });
