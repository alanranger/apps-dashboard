import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
for (const line of fs.readFileSync(path.join(root, '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { fetchHorizonEvents, gcalConfigured } = require('../api/mc/gcal-lib.js');
const { workshopEventDayRange, isWorkshopCalendarEvent } = require('../api/mc/habit-placer-lib.js');
const { isoToLondonDate } = require('../api/mc/scheduling-rules-lib.js');

if (!gcalConfigured()) throw new Error('no gcal');
const { events } = await fetchHorizonEvents('2026-07-25T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
const ws = (events || []).filter(isWorkshopCalendarEvent);
console.log('workshop events Jul25-Sep1:', ws.length);
for (const e of ws) {
  const range = workshopEventDayRange(e);
  const start = e.start?.date || e.start?.dateTime;
  const end = e.end?.date || e.end?.dateTime;
  console.log(JSON.stringify({
    title: e.summary,
    start, end,
    range,
    multi: range && range.lastDay > range.firstDay,
  }));
}
const hits = (events || []).filter((e) => /ward|hathersage|surprise|abstract|macro|batsford/i.test(e.summary || ''));
console.log('\nkeyword hits (any cal):', hits.length);
for (const e of hits) {
  console.log(JSON.stringify({
    title: e.summary,
    cal: e._calendarId || e.calendarId,
    start: e.start?.date || e.start?.dateTime,
    end: e.end?.date || e.end?.dateTime,
    workshop: isWorkshopCalendarEvent(e),
    range: workshopEventDayRange(e),
  }));
}
