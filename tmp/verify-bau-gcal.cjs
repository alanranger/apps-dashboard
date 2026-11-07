const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { getPrimaryEvent } = require('../api/mc/gcal-write-lib');
(async () => {
  for (const id of ['iu9lvq70d8ai3e199gb3dbn6fk', '7kfa1h8a4fb34aq2osiijo0e6o']) {
    const e = await getPrimaryEvent(id);
    console.log(JSON.stringify({
      id,
      status: e && e.status,
      summary: e && e.summary,
      start: e && e.start,
      end: e && e.end,
    }));
  }
})().catch((e) => { console.error(e); process.exit(1); });
