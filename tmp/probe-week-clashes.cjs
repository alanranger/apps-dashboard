const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '..', '.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const { sb } = require('../api/mc/_lib.js');
const { fetchHorizonEvents, gcalConfigured } = require('../api/mc/gcal-lib.js');
const { buildBusyIntervals } = require('../api/mc/habit-placer-lib.js');
const { ruleMapFromRows, isoToLondonDate } = require('../api/mc/scheduling-rules-lib.js');
const { isMcBlock } = require('../api/mc/rule-breach-lib.js');

function overlaps(a0, a1, b0, b1) { return a0 < b1 && b0 < a1; }

(async () => {
  if (!gcalConfigured()) throw new Error('no gcal');
  const rules = ruleMapFromRows(await sb('scheduling_rules?select=key,value'));
  const from = '2026-08-10';
  const to = '2026-08-16';
  const timeMin = `${from}T00:00:00Z`;
  const timeMax = `${to}T23:59:59Z`;
  const { events } = await fetchHorizonEvents(timeMin, timeMax);
  const primary = (events || []).filter((e) => (e._calendarId || 'primary') === 'primary' && e.start?.dateTime);
  console.log('Primary timed events this week:', primary.length);
  for (const e of primary.sort((a, b) => Date.parse(a.start.dateTime) - Date.parse(b.start.dateTime))) {
    const day = isoToLondonDate(e.start.dateTime);
    const tr = e.transparency || 'opaque';
    const mc = isMcBlock(e);
    console.log(
      `${day} ${String(e.start.dateTime).slice(11, 16)}-${String(e.end?.dateTime || '').slice(11, 16)} `
      + `[mc=${mc} free=${tr === 'transparent'} color=${e.colorId || '-'}] ${e.summary}`,
    );
  }
  const busy = buildBusyIntervals(events, rules);
  console.log('\nHard busy intervals count:', busy.length);
  const mcPrimary = primary.filter(isMcBlock);
  // Pairwise MC clashes
  for (let i = 0; i < mcPrimary.length; i += 1) {
    for (let j = i + 1; j < mcPrimary.length; j += 1) {
      const a = mcPrimary[i]; const b = mcPrimary[j];
      const a0 = Date.parse(a.start.dateTime); const a1 = Date.parse(a.end.dateTime);
      const b0 = Date.parse(b.start.dateTime); const b1 = Date.parse(b.end.dateTime);
      if (overlaps(a0, a1, b0, b1)) {
        console.log('MC×MC:', a.summary, '×', b.summary, isoToLondonDate(a.start.dateTime));
      }
    }
  }
  // MC vs personal busy
  for (const m of mcPrimary) {
    const m0 = Date.parse(m.start.dateTime); const m1 = Date.parse(m.end.dateTime);
    for (const b of busy) {
      if (overlaps(m0, m1, b.startMs, b.endMs)) {
        console.log('MC×BUSY:', m.summary, '@', isoToLondonDate(m.start.dateTime), 'vs', b.summary);
      }
    }
  }
})().catch((e) => { console.error(e); process.exit(1); });
