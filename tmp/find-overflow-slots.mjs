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
const {
  ruleMapFromRows, bankHolidaySet, isoToLondonMinutes, addDays,
} = require('../api/mc/scheduling-rules-lib.js');
const {
  buildBusyIntervals, awaySpansFromTravelBlocks, londonYmdHmToUtcMs,
} = require('../api/mc/habit-placer-lib.js');
const { fetchHorizonEvents } = require('../api/mc/gcal-lib.js');

const spike = JSON.parse(
  fs.readFileSync(path.join(root, 'tmp/habit-placer-spike-2026-07-26.json'), 'utf8'),
);

function hm(iso) {
  const m = isoToLondonMinutes(iso);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
function label(mins) {
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

const rules = ruleMapFromRows(await sb('scheduling_rules?select=key,value'));
const { events } = await fetchHorizonEvents('2026-08-01T00:00:00Z', '2026-08-25T23:59:59Z');
const travel = await sb(
  'travel_blocks?select=block_type,starts_at,ends_at,venue_name,workshop_title,workshop_start,workshop_row_key'
  + '&block_type=in.(travel_out,travel_back)'
  + '&starts_at=gte.2026-08-01T00:00:00Z&starts_at=lte.2026-08-25T23:59:59Z',
);
const away = awaySpansFromTravelBlocks(travel || []);
const busy = buildBusyIntervals(events || [], rules).concat(away);
for (const a of spike.amendments || []) {
  if (a.action === 'MOVE' || a.action === 'CREATE') {
    busy.push({ startMs: Date.parse(a.startIso), endMs: Date.parse(a.endIso), summary: a.title });
  }
}
for (const b of spike.task_bumps || []) {
  if (b.new_start) {
    busy.push({
      startMs: Date.parse(b.new_start), endMs: Date.parse(b.new_end), summary: `MC-${b.display_id}`,
    });
  }
}
busy.sort((a, b) => a.startMs - b.startMs);

function find(startDay, dur, name) {
  for (let i = 0; i <= 12; i += 1) {
    const day = addDays(startDay, i);
    if (away.some((s) => day >= s.startDay && day <= s.endDay)) continue;
    for (let m = 9 * 60; m + dur <= 17 * 60; m += 15) {
      const startMs = londonYmdHmToUtcMs(day, label(m));
      const endMs = londonYmdHmToUtcMs(day, label(m + dur));
      if (busy.some((b) => startMs < b.endMs && b.startMs < endMs)) continue;
      console.log(JSON.stringify({
        name, day, when: `${hm(new Date(startMs).toISOString())}–${hm(new Date(endMs).toISOString())}`,
        startIso: new Date(startMs).toISOString(), endIso: new Date(endMs).toISOString(),
      }));
      busy.push({ startMs, endMs, summary: name });
      return;
    }
  }
  console.log(JSON.stringify({ name, unplaced: true }));
}

find('2026-08-09', 30, 'MC-13');
find('2026-08-09', 45, 'MC-2');
find('2026-08-09', 60, 'MC-1');
find('2026-08-17', 60, 'MC-51');
