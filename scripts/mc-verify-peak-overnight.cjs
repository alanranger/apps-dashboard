/**
 * Confirm Peak Heathers chain after removing same-evening travel_back.
 * node scripts/mc-verify-peak-overnight.cjs
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { sb } = require('../api/mc/_lib');
const { fetchHorizonEvents } = require('../api/mc/gcal-lib');

(async () => {
  const rows = await sb(
    "travel_blocks?or=(workshop_title.ilike.*heather*,venue_name.ilike.*rudyard*)&select=block_type,starts_at,ends_at,workshop_title,leg_from,leg_to,calendar_event_id&order=starts_at.asc",
  );
  console.log('DB', JSON.stringify(rows, null, 2));

  const { events } = await fetchHorizonEvents('2026-08-15T00:00:00.000Z', '2026-08-17T00:00:00.000Z');
  const peak = (events || []).filter((e) => {
    const s = `${e.summary || ''} ${e.location || ''}`;
    return /heather|rudyard|2OQO|Roaches|Hathersage/i.test(s);
  }).map((e) => ({
    summary: e.summary,
    start: e.start?.dateTime || e.start?.date,
    end: e.end?.dateTime || e.end?.date,
    location: e.location,
  }));
  console.log('GCAL', JSON.stringify(peak, null, 2));
  const homeBack = peak.some((e) => /Travel back.*Heathers Sunset.*home/i.test(e.summary || ''));
  console.log('stale_home_back_present', homeBack);
})().catch((e) => { console.error(e); process.exit(1); });
