/* one-off audit: compare DB pins vs live GCal */
const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '..', '.env.local');
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([^#=]+)=(.*)$/);
  if (!m) continue;
  let v = m[2].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  process.env[m[1].trim()] = v;
}
const { getAccessToken } = require('../api/mc/gcal-lib');

async function getEvent(id) {
  const token = await getAccessToken();
  const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(id)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const j = await res.json();
  if (!res.ok) return { id, error: j.error?.message || res.status };
  const s = j.start?.dateTime || j.start?.date;
  const e = j.end?.dateTime || j.end?.date;
  const mins = s && e && String(s).includes('T')
    ? Math.round((Date.parse(e) - Date.parse(s)) / 60000)
    : null;
  return {
    summary: (j.summary || '').slice(0, 60),
    start: s,
    end: e,
    gcal_mins: mins,
    status: j.status,
  };
}

const rows = [
  ['MC9 db90', 'ei9abbk63335t4dqvbo1mpuk8k', 90],
  ['MC14 db45', '67det6a3a6nmgne3ovsobqneo8', 45],
  ['MC13 db30', 'p34808ive3mrlni2lulamed6h4', 30],
  ['BAU1-Aug17 db180', 'e3dlram4mfmqvotmng8km2j580', 180],
  ['BAU1-Sep8 db180', '57j6vscujgtbjnm37894fbhq5c', 180],
  ['BAU2-Aug19 db120', 'l6d5siuopnq2tjjbpcds1qe9ak', 120],
  ['BAU2-Sep9 db120', '4dcbq5m3g2pttimc3on9peoisg', 120],
  ['Schema-Oct26?', 'pqgdf036ab8lu44eccrbi74lv0', 120],
];

(async () => {
  for (const [label, id, dbMins] of rows) {
    const r = await getEvent(id);
    const mismatch = r.gcal_mins != null && r.gcal_mins !== dbMins;
    console.log(JSON.stringify({
      label, dbMins, mismatch: !!mismatch, ...r,
    }));
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
