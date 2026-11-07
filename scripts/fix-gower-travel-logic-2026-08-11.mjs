/**
 * Correct Gower travel via desiredTravelTimes (workshop-end back, not hotel).
 * Apply DB + GCal + AWAY re-span. node scripts/fix-gower-travel-logic-2026-08-11.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

for (const line of fs.readFileSync(path.join(root, '.env.local'), 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#') || !line.includes('=')) continue;
  const i = line.indexOf('=');
  let v = line.slice(i + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  const k = line.slice(0, i).trim();
  if (!process.env[k]) process.env[k] = v;
}

const { desiredTravelTimes } = require('../api/mc/travel-regenerate-lib.js');
const {
  patchPrimaryEvent,
  deletePrimaryEvent,
  insertPrimaryAllDayEvent,
  verifyPrimaryEvent,
} = require('../api/mc/gcal-write-lib.js');
const {
  travelGcalTitle,
  travelGcalDescription,
  travelGcalLocation,
  awaySpanGcalTitle,
} = require('../api/mc/gcal-title-lib.js');
const { addDaysYmd } = require('../api/mc/diary-lib.js');

const MC_URL = process.env.MC_SUPABASE_URL;
const MC_KEY = process.env.MC_SUPABASE_SERVICE_KEY;

async function sb(p, opts = {}) {
  const r = await fetch(`${MC_URL}/rest/v1/${p}`, {
    method: opts.method || 'GET',
    headers: {
      apikey: MC_KEY,
      Authorization: `Bearer ${MC_KEY}`,
      'Content-Type': 'application/json',
      Prefer: opts.prefer || 'return=representation',
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`${opts.method || 'GET'} ${p} → ${t.slice(0, 500)}`);
  return t ? JSON.parse(t) : null;
}

const WORKSHOP_ID = '_6or34or571i36chg75j6aohn6pj30e326lgjipi0etrnebj1dhgmssj1dpjmashecdnmq';
// Live GCal: Fri 2027-05-28T10:00+01 → Sun 2027-05-30T14:00+01
const bounds = {
  startMs: Date.parse('2027-05-28T09:00:00.000Z'),
  endMs: Date.parse('2027-05-30T13:00:00.000Z'),
  startIso: '2027-05-28T09:00:00.000Z',
  endIso: '2027-05-30T13:00:00.000Z',
};
const driveMin = 195;
const arriveMin = 30;
const pairProxy = {
  out: { starts_at: '2027-05-28T05:15:00.000Z' },
  back: { starts_at: '2027-05-30T13:00:00.000Z' },
};

const desired = desiredTravelTimes(bounds, driveMin, arriveMin, pairProxy, {}, {
  guestOrAttending: false,
});
console.log('desired (residential first-day arrival, back at workshop end):', desired);

const rows = await sb(
  `travel_blocks?select=*&workshop_row_key=eq.gcal:${WORKSHOP_ID}&order=starts_at.asc`,
);
const out = (rows || []).find((r) => r.block_type === 'travel_out');
const back = (rows || []).find((r) => r.block_type === 'travel_back');
if (!out || !back) throw new Error('Gower travel_blocks missing — seed first');

const title = out.workshop_title;
const venue = out.venue_name;

// Patch DB
await sb(`travel_blocks?id=eq.${out.id}`, {
  method: 'PATCH',
  prefer: 'return=minimal',
  body: {
    starts_at: desired.out.starts_at,
    ends_at: desired.out.ends_at,
    workshop_start: desired.workshop_start,
    drive_minutes_used: driveMin,
  },
});
await sb(`travel_blocks?id=eq.${back.id}`, {
  method: 'PATCH',
  prefer: 'return=minimal',
  body: {
    starts_at: desired.back.starts_at,
    ends_at: desired.back.ends_at,
    workshop_start: desired.workshop_start,
    drive_minutes_used: driveMin,
  },
});

// Patch GCal titles + times
for (const [row, times, type] of [
  [out, desired.out, 'travel_out'],
  [back, desired.back, 'travel_back'],
]) {
  const meta = {
    block_type: type,
    workshop_title: title,
    venue_name: venue,
    leg_from: row.leg_from,
    leg_to: row.leg_to,
    drive_minutes_used: driveMin,
  };
  await patchPrimaryEvent(row.calendar_event_id, {
    summary: travelGcalTitle(meta),
    startIso: times.starts_at,
    endIso: times.ends_at,
    description: travelGcalDescription(meta),
    location: travelGcalLocation(meta),
  });
  const v = await verifyPrimaryEvent(row.calendar_event_id, {
    summary: travelGcalTitle(meta),
    startIso: times.starts_at,
    endIso: times.ends_at,
  });
  if (!v.ok) console.warn('verify failed', type, v);
}

// AWAY = travel-out day through travel-back day inclusive (Fri–Sun, not Mon)
const awayStart = '2027-05-28';
const awayEnd = '2027-05-30';
const awayEndEx = addDaysYmd(awayEnd, 1);
const awayTitle = awaySpanGcalTitle({ venue_name: venue, workshop_title: title });

const aways = await sb(
  `away_day_blocks?status=eq.active&or=(workshop_row_key.eq.gcal:${WORKSHOP_ID},venue_name.ilike.*Gower*)&select=*`,
);
for (const a of aways || []) {
  const body = {
    start_date: awayStart,
    end_date: awayEnd,
    workshop_title: title,
    venue_name: venue,
    workshop_row_key: `gcal:${WORKSHOP_ID}`,
    updated_at: new Date().toISOString(),
  };
  if (a.calendar_event_id) {
    try {
      await deletePrimaryEvent(a.calendar_event_id);
    } catch (_) { /* ok */ }
  }
  const ev = await insertPrimaryAllDayEvent({
    summary: awayTitle,
    startDate: awayStart,
    endDateExclusive: awayEndEx,
    description: 'AWAY re-derived: travel_out→travel_back after workshop-end logic fix',
  });
  body.calendar_event_id = ev.id;
  await sb(`away_day_blocks?id=eq.${a.id}`, {
    method: 'PATCH',
    prefer: 'return=minimal',
    body,
  });
  console.log('away updated', a.id, awayStart, '→', awayEnd, ev.id);
}

// REST Mon 31 stays (day after last workshop day) — no change

console.log(JSON.stringify({
  ok: true,
  mode: desired.mode,
  travel_out: desired.out,
  travel_back: desired.back,
  note: 'travel_back anchored at workshop end 2027-05-30 14:00 London; AWAY Fri–Sun',
}, null, 2));
