const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { getPrimaryEvent } = require('../api/mc/gcal-write-lib');
(async () => {
  for (const id of [
    'sv7fhef5cf1cphmhrg74m3fk18',
    '5hpmtn7frbn1f08l94i7555st8',
    'csm1g0lvgdur0m34iu2inf5l7c',
  ]) {
    const e = await getPrimaryEvent(id);
    console.log(JSON.stringify({
      id,
      summary: e.summary,
      start: e.start?.dateTime,
      end: e.end?.dateTime,
    }));
  }
})().catch((e) => { console.error(e); process.exit(1); });
