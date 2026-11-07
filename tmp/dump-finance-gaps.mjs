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
const { fetchHorizonEvents } = require('../api/mc/gcal-lib.js');
const { buildBusyIntervals, londonYmdHmToUtcMs } = require('../api/mc/habit-placer-lib.js');
const { ruleMapFromRows, workingWindow, isoToLondonDate, isoToLondonMinutes } = require('../api/mc/scheduling-rules-lib.js');
const { sb } = require('../api/mc/_lib.js');

function hm(ms) {
  const m = isoToLondonMinutes(new Date(ms).toISOString());
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

const ruleMap = ruleMapFromRows(await sb('scheduling_rules?select=key,value'));
const tasks = await sb('tasks?select=display_id,calendar_event_id&display_id=in.(21,22,23)');
const skip = new Set(tasks.map((t) => t.calendar_event_id).filter(Boolean));
const { events } = await fetchHorizonEvents('2026-07-29T00:00:00Z', '2026-07-30T23:59:59Z');
const clientBusy = buildBusyIntervals(events, ruleMap);
const busy = clientBusy.slice();
for (const e of events) {
  if ((e._calendarId || 'primary') !== 'primary') continue;
  if (skip.has(e.id) || !e.start?.dateTime) continue;
  busy.push({
    startMs: Date.parse(e.start.dateTime),
    endMs: Date.parse(e.end.dateTime),
    summary: e.summary,
  });
}
busy.sort((a, b) => a.startMs - b.startMs);

for (const day of ['2026-07-29', '2026-07-30']) {
  const win = workingWindow(ruleMap, day);
  const dayStart = londonYmdHmToUtcMs(day, `${String(Math.floor(win.start_min / 60)).padStart(2, '0')}:${String(win.start_min % 60).padStart(2, '0')}`);
  const dayEnd = londonYmdHmToUtcMs(day, `${String(Math.floor(win.end_min / 60)).padStart(2, '0')}:${String(win.end_min % 60).padStart(2, '0')}`);
  const dayBusy = busy.filter((b) => b.endMs > dayStart && b.startMs < dayEnd)
    .sort((a, b) => a.startMs - b.startMs);
  console.log('\n===', day, 'window', win.start_min, '-', win.end_min, '===');
  for (const b of dayBusy) {
    console.log(hm(b.startMs), '-', hm(b.endMs), b.summary);
  }
  // gaps
  let cursor = dayStart;
  for (const b of dayBusy) {
    if (b.startMs > cursor) {
      console.log('GAP', hm(cursor), '-', hm(b.startMs), `(${Math.round((b.startMs - cursor) / 60000)}m)`);
    }
    cursor = Math.max(cursor, b.endMs);
  }
  if (cursor < dayEnd) console.log('GAP', hm(cursor), '-', hm(dayEnd), `(${Math.round((dayEnd - cursor) / 60000)}m)`);
}
