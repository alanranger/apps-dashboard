const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { idealsInHorizon } = require('../api/mc/rrule-core');
const { getAccessToken } = require('../api/mc/gcal-lib');

console.log('BAU1', idealsInHorizon('FREQ=WEEKLY;INTERVAL=8;BYDAY=MO', '2026-07-30', '2027-02-15'));
console.log('BAU2', idealsInHorizon('FREQ=WEEKLY;INTERVAL=8;BYDAY=TU', '2026-07-30', '2027-02-15'));
console.log('Upload', idealsInHorizon('FREQ=WEEKLY;INTERVAL=8;BYDAY=WE', '2026-07-30', '2027-02-15'));
console.log('Backup', idealsInHorizon('FREQ=MONTHLY;INTERVAL=2;BYDAY=4MO', '2026-07-30', '2027-02-15'));

(async () => {
  const token = await getAccessToken();
  const ids = [
    ['ghostBAU1', 'e3dlram4mfmqvotmng8km2j580'],
    ['ghostBAU2', 'l6d5siuopnq2tjjbpcds1qe9ak'],
    ['keepBAU1', '57j6vscujgtbjnm37894fbhq5c'],
    ['keepUpload', 'a3j57nmqj23h7qbf9lds4jgnp4'],
  ];
  for (const [label, id] of ids) {
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events/${id}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const j = await res.json();
    console.log(label, res.status, j.status || j.error?.message, (j.summary || '').slice(0, 40));
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
