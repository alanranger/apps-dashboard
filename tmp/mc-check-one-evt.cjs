const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { getPrimaryEvent } = require('../api/mc/gcal-write-lib');
(async () => {
  for (const id of ['eig0evuh8l3m53rmctvav7nmlg', '3vc9se5d7qraoe0ne5t024qqm8', '407p2grjld1v35cs55iscru3ek']) {
    try {
      const e = await getPrimaryEvent(id);
      console.log(id, e.status, e.summary, e.start?.dateTime, e.end?.dateTime);
    } catch (err) {
      console.log(id, 'ERR', err.status, err.message);
    }
  }
})().catch((e) => { console.error(e); process.exit(1); });
