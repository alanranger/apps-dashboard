/**
 * Fix Peak District Heathers overnight chain (15–16 Aug 2026):
 * travel out (15th) → sunset → hotel → sunrise leg → travel home after sunrise.
 * Also retimes overlapping decompress buffers.
 *
 * node scripts/mc-fix-peak-heathers-overnight.cjs [--dry-run]
 */
const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '..', '.env.local');
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { sb } = require('../api/mc/_lib');
const { patchPrimaryEvent, verifyPrimaryEvent } = require('../api/mc/gcal-write-lib');
const {
  travelGcalTitle, travelGcalLocation, travelGcalDescription,
} = require('../api/mc/gcal-title-lib');

const PREFIXES = { travel: 'MC 🚗', buffer: 'MC ⏳' };

const IDS = {
  out: 'a3bd1f83-1720-4260-8c4e-da13089d0f41',
  back: 'eabe88e9-31bb-4a4a-8517-77f1e56910f1',
  hotel: '3d3c9c0e-9ce5-41fe-9eb2-e158d000bc80',
  sunriseLeg: '4fc10929-471a-482c-9dc1-4ac40e5231b4',
  decompressSunset: '0fcb4ca6-1af1-43a7-9a87-71a72743a2c1',
  decompressSunrise: '7d207d91-0792-4230-943d-3a1ac455e522',
};

const SUNSET_START = '2026-08-15T17:15:00.000Z'; // 18:15 London
const SUNSET_END = '2026-08-15T20:15:00.000Z'; // 21:15 London
const SUNRISE_START = '2026-08-16T04:45:00.000Z'; // 05:45 London
const SUNRISE_END = '2026-08-16T07:45:00.000Z'; // 08:45 London
const SUNSET_ROW = 'gcal:_6lh64ohn6oqj6c9g6hhjeoho64rjacphcopj4oa0etrnebj1dhgmssj1dpjmashecdnmq';
const SUNRISE_ROW = 'gcal:_6oq38d9jc4rmao9kccp6cp1n60sj4e1l6th66ci0etrnebj1dhgmssj1dpjmashecdnmq';

/** Arrive 30 before sunset; 120 min drive → 15:45–17:45 London */
const OUT = {
  starts_at: '2026-08-15T14:45:00.000Z',
  ends_at: '2026-08-15T16:45:00.000Z',
};
/** Hotel after sunset; 35 min */
const HOTEL = {
  starts_at: '2026-08-15T20:15:00.000Z',
  ends_at: '2026-08-15T20:50:00.000Z',
};
/** Hotel → Roaches (keep) */
const SUNRISE_LEG = {
  starts_at: '2026-08-16T04:00:00.000Z',
  ends_at: '2026-08-16T04:15:00.000Z',
};
/** Home after sunrise; 120 min → 08:45–10:45 London */
const BACK = {
  starts_at: '2026-08-16T07:45:00.000Z',
  ends_at: '2026-08-16T09:45:00.000Z',
};
/** Decompress after hotel arrival */
const DEC_SUNSET = {
  starts_at: '2026-08-15T20:50:00.000Z',
  ends_at: '2026-08-15T21:20:00.000Z',
  day: '2026-08-15',
};
/** Decompress after arriving home */
const DEC_SUNRISE = {
  starts_at: '2026-08-16T09:45:00.000Z',
  ends_at: '2026-08-16T10:15:00.000Z',
  day: '2026-08-16',
};

async function patchTravel(row, patch) {
  const next = { ...row, ...patch };
  await sb(`travel_blocks?id=eq.${row.id}`, {
    method: 'PATCH', prefer: 'return=minimal', body: patch,
  });
  if (!row.calendar_event_id) return { id: row.id, gcal: false };
  const summary = travelGcalTitle(next, PREFIXES);
  const location = travelGcalLocation(next);
  const description = travelGcalDescription(next);
  await patchPrimaryEvent(row.calendar_event_id, {
    summary,
    location,
    description,
    startIso: next.starts_at,
    endIso: next.ends_at,
  });
  const v = await verifyPrimaryEvent(row.calendar_event_id, {
    summary,
    startIso: next.starts_at,
    endIso: next.ends_at,
  });
  return { id: row.id, type: next.block_type, summary, starts_at: next.starts_at, ends_at: next.ends_at, ok: v.ok };
}

async function patchBuffer(row, times) {
  const patch = {
    starts_at: times.starts_at,
    ends_at: times.ends_at,
    day: times.day,
    duration_min: Math.round((Date.parse(times.ends_at) - Date.parse(times.starts_at)) / 60000),
  };
  await sb(`gap_buffer_blocks?id=eq.${row.id}`, {
    method: 'PATCH', prefer: 'return=minimal', body: patch,
  });
  if (!row.calendar_event_id) return { id: row.id, gcal: false };
  const summary = `MC ⏳ Decompress — after ${row.after_label || 'workshop'}`;
  await patchPrimaryEvent(row.calendar_event_id, {
    summary,
    startIso: times.starts_at,
    endIso: times.ends_at,
  });
  const v = await verifyPrimaryEvent(row.calendar_event_id, {
    summary,
    startIso: times.starts_at,
    endIso: times.ends_at,
  });
  return { id: row.id, summary, starts_at: times.starts_at, ends_at: times.ends_at, ok: v.ok };
}

async function main() {
  const dry = process.argv.includes('--dry-run');
  const plan = {
    out: { ...OUT, workshop_start: SUNSET_START, workshop_row_key: SUNSET_ROW, workshop_title: 'Peak District Heathers Sunset', venue_name: 'Surprise View / Hathersage', leg_from: 'CV4 9HW', leg_to: 'S32 1BE', drive_minutes_used: 120 },
    hotel: { ...HOTEL, workshop_start: SUNSET_START, workshop_title: 'Peak District Heathers Sunset -> overnight', venue_name: 'Hotel Rudyard', leg_from: 'S32 1BE', leg_to: 'Hotel Rudyard', drive_minutes_used: 35 },
    sunriseLeg: { ...SUNRISE_LEG, workshop_start: SUNRISE_START, workshop_title: 'Peak District Heathers Sunrise', venue_name: 'The Roaches / Leek', leg_from: 'Hotel Rudyard', leg_to: 'ST13 8UA', drive_minutes_used: 10 },
    back: {
      ...BACK,
      workshop_start: SUNRISE_START,
      workshop_row_key: SUNRISE_ROW,
      workshop_title: 'Peak District Heathers Sunrise',
      venue_name: 'The Roaches / Leek',
      leg_from: 'ST13 8UA',
      leg_to: 'CV4 9HW',
      drive_minutes_used: 120,
    },
    decompressSunset: DEC_SUNSET,
    decompressSunrise: DEC_SUNRISE,
  };
  console.log(JSON.stringify({ dry, plan }, null, 2));
  if (dry) return;

  const [travels, buffers] = await Promise.all([
    sb(`travel_blocks?id=in.(${IDS.out},${IDS.back},${IDS.hotel},${IDS.sunriseLeg})`),
    sb(`gap_buffer_blocks?id=in.(${IDS.decompressSunset},${IDS.decompressSunrise})`),
  ]);
  const byId = Object.fromEntries((travels || []).map((r) => [r.id, r]));
  const bufById = Object.fromEntries((buffers || []).map((r) => [r.id, r]));

  const results = [];
  results.push(await patchTravel(byId[IDS.out], {
    starts_at: plan.out.starts_at,
    ends_at: plan.out.ends_at,
    workshop_start: plan.out.workshop_start,
    workshop_row_key: plan.out.workshop_row_key,
    workshop_title: plan.out.workshop_title,
    venue_name: plan.out.venue_name,
    leg_from: plan.out.leg_from,
    leg_to: plan.out.leg_to,
    drive_minutes_used: plan.out.drive_minutes_used,
  }));
  results.push(await patchTravel(byId[IDS.hotel], {
    starts_at: plan.hotel.starts_at,
    ends_at: plan.hotel.ends_at,
    workshop_start: plan.hotel.workshop_start,
    workshop_title: plan.hotel.workshop_title,
    drive_minutes_used: plan.hotel.drive_minutes_used,
  }));
  results.push(await patchTravel(byId[IDS.sunriseLeg], {
    starts_at: plan.sunriseLeg.starts_at,
    ends_at: plan.sunriseLeg.ends_at,
    workshop_start: plan.sunriseLeg.workshop_start,
    workshop_title: plan.sunriseLeg.workshop_title,
  }));
  results.push(await patchTravel(byId[IDS.back], {
    starts_at: plan.back.starts_at,
    ends_at: plan.back.ends_at,
    workshop_start: plan.back.workshop_start,
    workshop_row_key: plan.back.workshop_row_key,
    workshop_title: plan.back.workshop_title,
    venue_name: plan.back.venue_name,
    leg_from: plan.back.leg_from,
    leg_to: plan.back.leg_to,
    drive_minutes_used: plan.back.drive_minutes_used,
  }));
  if (bufById[IDS.decompressSunset]) {
    results.push(await patchBuffer(bufById[IDS.decompressSunset], plan.decompressSunset));
  }
  if (bufById[IDS.decompressSunrise]) {
    results.push(await patchBuffer(bufById[IDS.decompressSunrise], plan.decompressSunrise));
  }

  console.log(JSON.stringify({ applied: results }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
