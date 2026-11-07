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
const { ruleMapFromRows, numRule } = require('../api/mc/scheduling-rules-lib.js');
const {
  awaySpansFromTravelBlocks,
  dayBlockedForPlacement,
  fuelWindowsForDay,
  trySlotOnDay,
  londonDay,
} = require('../api/mc/habit-placer-lib.js');

const REST = new Set([
  '2026-08-17', '2026-09-14', '2026-09-21', '2026-09-28', '2026-10-05',
  '2026-10-26', '2026-11-02', '2026-11-16', '2026-11-23',
]);

const rules = await sb('scheduling_rules?select=key,value');
const ruleMap = ruleMapFromRows(rules);
const travel = await sb(
  'travel_blocks?select=block_type,starts_at,ends_at,venue_name,workshop_title,workshop_start,workshop_row_key'
  + '&block_type=in.(travel_out,travel_back)&starts_at=gte.2026-07-01T00:00:00Z&starts_at=lte.2026-12-01T23:59:59Z',
);
const spans = awaySpansFromTravelBlocks(travel || [], ruleMap);
const classes = await sb(
  'class_fixture_blocks?select=starts_at,ends_at,title,kind'
  + '&starts_at=gte.2026-07-01T00:00:00Z&starts_at=lte.2026-12-01T23:59:59Z',
);
const busy = [];
for (const c of classes || []) {
  if (c.starts_at && c.ends_at) busy.push({ start: new Date(c.starts_at), end: new Date(c.ends_at), summary: c.title });
}

const targets = [
  { title: 'BAU global refresh — Day 1: CSVs + preliminary ingest', monday: '2026-08-17', dur: 240 },
  { title: 'Update Event Schema for Classes & Workshops', monday: '2026-09-28', dur: 30 },
  { title: 'Review/Amend Course & Workshop Dates + check Hotel Bookings', monday: '2026-10-05', dur: 30 },
];

function addDays(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

for (const t of targets) {
  console.log('\n===', t.title, 'from', t.monday, '===');
  let found = null;
  for (let back = 1; back <= 60; back++) {
    const day = addDays(t.monday, -back);
    const blocked = dayBlockedForPlacement(day, spans);
    const rest = REST.has(day);
    if (blocked || rest) {
      if (back <= 14 || rest) console.log(day, blocked ? 'BLOCKED' : 'REST');
      continue;
    }
    const windows = fuelWindowsForDay(day, ruleMap, busy);
    const slot = trySlotOnDay({
      day,
      durationMin: t.dur,
      windows,
      busyBlocks: busy,
      preferredHour: 10,
      preferredMinute: 0,
    });
    console.log(day, 'windows', windows.length, 'slot', slot ? `${slot.start.toISOString()}–${slot.end.toISOString()}` : 'none');
    if (slot) {
      found = { day, slot };
      break;
    }
  }
  console.log('FOUND', found ? found.day : null);
}
