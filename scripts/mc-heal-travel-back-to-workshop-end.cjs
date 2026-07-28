/**
 * Force travel_back to live workshop end when Google is stale vs formula.
 * Fixes fixture-slide leftovers for Batsford day-trips.
 * node scripts/mc-heal-travel-back-to-workshop-end.cjs
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { sb } = require('../api/mc/_lib');
const { fetchHorizonEvents } = require('../api/mc/gcal-lib');
const { patchPrimaryEvent, verifyPrimaryEvent } = require('../api/mc/gcal-write-lib');
const { ruleMapFromRows } = require('../api/mc/scheduling-rules-lib');
const { planTravelRegenerate } = require('../api/mc/travel-regenerate-lib');
const { londonToday, addDaysYmd } = require('../api/mc/diary-lib');

async function main() {
  const today = londonToday();
  const [blocks, rules, venues, gcal] = await Promise.all([
    sb('travel_blocks?select=*&block_type=in.(travel_out,travel_back)&order=starts_at.asc'),
    sb('scheduling_rules?select=key,value'),
    sb('venue_drive_times?select=venue_name,minutes_from_home'),
    fetchHorizonEvents(`${addDaysYmd(today, -14)}T00:00:00.000Z`, `${addDaysYmd(today, 400)}T00:00:00.000Z`),
  ]);
  const plan = planTravelRegenerate(
    blocks || [], gcal.events || [], ruleMapFromRows(rules || []), venues || [],
  );
  // Prefer linked desired times even when DB already matches (Google may be stale).
  let fixed = 0;
  for (const row of plan.linked || []) {
    const id = row.back.calendar_event_id;
    if (!id) continue;
    const startIso = row.back.to.starts_at;
    const endIso = row.back.to.ends_at;
    const live = (gcal.events || []).find((e) => e.id === id);
    const liveStart = live?.start?.dateTime;
    if (liveStart && Math.abs(Date.parse(liveStart) - Date.parse(startIso)) <= 120000) continue;
    await sb(`travel_blocks?id=eq.${row.back.id}`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: { starts_at: startIso, ends_at: endIso },
    });
    await patchPrimaryEvent(id, { startIso, endIso });
    const v = await verifyPrimaryEvent(id, { startIso, endIso });
    console.log(v.ok ? 'fixed' : 'FAIL', (row.title || '').slice(0, 55), liveStart, '->', startIso);
    fixed += 1;
  }
  console.log(JSON.stringify({ linked: (plan.linked || []).length, fixed }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
