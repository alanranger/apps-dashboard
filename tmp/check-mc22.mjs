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
const { sb } = require('../api/mc/_lib.js');
const { gcalConfigured, fetchHorizonEvents } = require('../api/mc/gcal-lib.js');
const { isoToLondonDate, isoToLondonMinutes } = require('../api/mc/scheduling-rules-lib.js');
const { londonYmdHmToUtcMs } = require('../api/mc/habit-placer-lib.js');

function hm(iso) {
  const m = isoToLondonMinutes(iso);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function overlaps(a0, a1, b0, b1) {
  return a0 < b1 && b0 < a1;
}

const tasks = await sb(
  'tasks?select=display_id,title,scheduled_start,scheduled_end,calendar_event_id,depends_on_task_id&display_id=in.(9,21,22,23,25,50,51)',
);
console.log('=== DB (as timestamptz → London) ===');
for (const t of tasks || []) {
  console.log(
    `MC-${t.display_id}`,
    t.scheduled_start,
    '→',
    isoToLondonDate(t.scheduled_start),
    hm(t.scheduled_start),
    '-',
    hm(t.scheduled_end),
    'event',
    t.calendar_event_id,
    'dep',
    t.depends_on_task_id,
  );
}

const hotelStart = londonYmdHmToUtcMs('2026-07-29', '11:15');
const hotelEnd = londonYmdHmToUtcMs('2026-07-29', '12:00');
const mc22 = (tasks || []).find((t) => Number(t.display_id) === 22);
if (mc22) {
  const t0 = Date.parse(mc22.scheduled_start);
  const t1 = Date.parse(mc22.scheduled_end);
  console.log('=== overlap Hotel Alan 11:15–12:00 London vs MC-22 DB ===');
  console.log('hotel UTC', new Date(hotelStart).toISOString(), new Date(hotelEnd).toISOString());
  console.log('mc22 UTC', new Date(t0).toISOString(), new Date(t1).toISOString());
  console.log('overlap?', overlaps(hotelStart, hotelEnd, t0, t1));
}

if (gcalConfigured()) {
  const { events } = await fetchHorizonEvents('2026-07-29T00:00:00Z', '2026-07-30T23:59:59Z');
  console.log('=== GCal Primary 29 Jul hits ===');
  for (const e of events || []) {
    if ((e._calendarId || e.calendarId || 'primary') !== 'primary') continue;
    const s = e.summary || '';
    if (!/hotel|joining|card|Admiral|Clear-down|MC-22/i.test(s)
      && e.id !== '42a5ajb5kt5knccdt0c1tkahfk') continue;
    console.log(
      s,
      e.start?.dateTime,
      '→',
      isoToLondonDate(e.start.dateTime),
      hm(e.start.dateTime),
      '-',
      hm(e.end.dateTime),
      e.id,
    );
  }
}
