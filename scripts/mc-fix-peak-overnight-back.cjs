/**
 * Peak Heathers overnight: remove conflicting same-evening travel_back→home.
 * Keep travel_out + overnight hotel leg + next-morning hotel→Roaches.
 * node scripts/mc-fix-peak-overnight-back.cjs
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { sb } = require('../api/mc/_lib');
const { deletePrimaryEvent } = require('../api/mc/gcal-write-lib');

const BACK_ID = 'eabe88e9-31bb-4a4a-8517-77f1e56910f1';
const BACK_EVENT = 'ts65eqjeureb4nl3qed17sg8qk';

(async () => {
  const row = (await sb(`travel_blocks?id=eq.${BACK_ID}&select=*`))?.[0];
  console.log('row', row ? {
    block_type: row.block_type,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    workshop_title: row.workshop_title,
    leg_from: row.leg_from,
    leg_to: row.leg_to,
    calendar_event_id: row.calendar_event_id,
  } : null);

  if (!row) {
    console.log('already gone');
    return;
  }

  try {
    await deletePrimaryEvent(row.calendar_event_id || BACK_EVENT);
    console.log('gcal deleted', row.calendar_event_id || BACK_EVENT);
  } catch (e) {
    console.log('gcal delete', e.message);
  }

  await sb(`travel_blocks?id=eq.${BACK_ID}`, { method: 'DELETE', prefer: 'return=minimal' });
  console.log('db deleted', BACK_ID);

  const left = await sb(
    "travel_blocks?workshop_title=ilike.*heather*&select=id,block_type,starts_at,ends_at,venue_name,workshop_title,leg_from,leg_to&order=starts_at.asc",
  );
  console.log(JSON.stringify(left, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
