/** Spot-check known-bad days live. */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { sb } = require('../api/mc/_lib');
const { fetchHorizonEvents } = require('../api/mc/gcal-lib');
const { ruleMapFromRows } = require('../api/mc/scheduling-rules-lib');
const { validateLiveableDiary } = require('../api/mc/liveable-diary-lib');

async function check(label, min, max) {
  const rules = await sb('scheduling_rules?select=key,value');
  const ruleMap = ruleMapFromRows(rules || []);
  const [gcal, travel] = await Promise.all([
    fetchHorizonEvents(min, max),
    sb(`travel_blocks?select=*&starts_at=gte.${min}&starts_at=lt.${max}`),
  ]);
  const liveable = validateLiveableDiary({
    events: gcal.events || [], travelBlocks: travel || [], ruleMap,
  });
  const jo = (gcal.events || []).filter((e) => /galloway|Review\/Amend|Decompress — after P3 · MC-20/i.test(e.summary || ''));
  console.log(JSON.stringify({
    label,
    ok: liveable.ok,
    by_rule: liveable.by_rule,
    n: liveable.violation_count,
    sample: liveable.violations.slice(0, 10),
    jo_related: jo.map((e) => ({
      summary: e.summary, start: e.start?.dateTime || e.start?.date, end: e.end?.dateTime || e.end?.date, cal: e._calendarId,
    })),
  }, null, 2));
}

(async () => {
  await check('12 Aug', '2026-08-12T00:00:00.000Z', '2026-08-13T00:00:00.000Z');
  await check('15-16 Aug', '2026-08-15T00:00:00.000Z', '2026-08-17T00:00:00.000Z');
  await check('17 Aug', '2026-08-17T00:00:00.000Z', '2026-08-18T00:00:00.000Z');
  await check('3-9 Aug', '2026-08-03T00:00:00.000Z', '2026-08-10T00:00:00.000Z');
})().catch((e) => { console.error(e); process.exit(1); });
