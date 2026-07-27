/**
 * Retire/retime travel_back that overlaps a travel_leg (multi-leg trips).
 * node scripts/mc-fix-travel-leg-back-overlap.cjs
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { sb } = require('../api/mc/_lib');
const { fetchHorizonEvents } = require('../api/mc/gcal-lib');
const { deletePrimaryEvent, patchPrimaryEvent } = require('../api/mc/gcal-write-lib');
const { travelGcalTitle, travelGcalLocation, travelGcalDescription } = require('../api/mc/gcal-title-lib');
const { ruleMapFromRows } = require('../api/mc/scheduling-rules-lib');
const { londonToday, addDaysYmd } = require('../api/mc/diary-lib');

function overlaps(a0, a1, b0, b1) {
  return a0 < b1 && b0 < a1;
}

function titleHit(a, b) {
  const na = String(a || '').toLowerCase();
  const nb = String(b || '').toLowerCase();
  if (!na || !nb) return false;
  return na.includes('heathers') && nb.includes('heathers')
    || na.includes(nb.slice(0, 12)) || nb.includes(na.slice(0, 12));
}

async function main() {
  const today = londonToday();
  const [blocks, rules, gcal] = await Promise.all([
    sb('travel_blocks?select=*&order=starts_at.asc'),
    sb('scheduling_rules?select=key,value'),
    fetchHorizonEvents(`${addDaysYmd(today, -30)}T00:00:00.000Z`, `${addDaysYmd(today, 200)}T00:00:00.000Z`),
  ]);
  const ruleMap = ruleMapFromRows(rules || []);
  const prefixes = { travel: ruleMap.title_prefix_travel || 'MC 🚗' };
  const legs = (blocks || []).filter((b) => b.block_type === 'travel_leg');
  const backs = (blocks || []).filter((b) => b.block_type === 'travel_back');
  const fixed = [];

  for (const back of backs) {
    const b0 = Date.parse(back.starts_at);
    const b1 = Date.parse(back.ends_at);
    const hitLegs = legs.filter((leg) => {
      const l0 = Date.parse(leg.starts_at);
      const l1 = Date.parse(leg.ends_at);
      return overlaps(b0, b1, l0, l1)
        || (titleHit(back.workshop_title, leg.workshop_title) && l0 >= b0 - 6 * 3600000 && l0 <= b1 + 36 * 3600000);
    });
    if (!hitLegs.length) continue;

    // Last related leg end → travel_back starts after that (+ drive from venue)
    const relatedLegs = legs.filter((leg) => titleHit(back.workshop_title, leg.workshop_title)
      || titleHit(back.venue_name, leg.venue_name)
      || hitLegs.some((h) => h.id === leg.id));
    const lastLeg = relatedLegs.sort((a, b) => Date.parse(a.ends_at) - Date.parse(b.ends_at)).at(-1);
    if (!lastLeg) continue;

    // Prefer live workshop end after last leg
    const workshops = (gcal.events || []).filter((e) => {
      const t = e.summary || '';
      return /heathers|roaches|peak district/i.test(t) && e.start?.dateTime;
    });
    let endMs = Date.parse(lastLeg.ends_at);
    for (const w of workshops) {
      const wEnd = Date.parse(w.end?.dateTime || w.start.dateTime);
      if (wEnd > endMs && wEnd < endMs + 48 * 3600000) endMs = wEnd;
    }
    const driveMin = Math.max(15, Number(back.drive_minutes_used) || 120);
    const newStart = new Date(endMs).toISOString();
    const newEnd = new Date(endMs + driveMin * 60000).toISOString();
    if (Math.abs(Date.parse(back.starts_at) - endMs) < 120000) continue;

    await sb(`travel_blocks?id=eq.${back.id}`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: { starts_at: newStart, ends_at: newEnd },
    });
    if (back.calendar_event_id) {
      const block = {
        block_type: 'travel_back',
        venue_name: back.venue_name,
        workshop_title: back.workshop_title,
        leg_from: back.leg_from,
        leg_to: back.leg_to,
        drive_minutes_used: driveMin,
      };
      await patchPrimaryEvent(back.calendar_event_id, {
        startIso: newStart,
        endIso: newEnd,
        summary: travelGcalTitle(block, prefixes),
        location: travelGcalLocation(block),
        description: travelGcalDescription(block),
      }).catch(async () => {
        try { await deletePrimaryEvent(back.calendar_event_id); } catch (_) { /* ignore */ }
      });
    }
    fixed.push({
      id: back.id, venue: back.venue_name, from: back.starts_at, to: newStart, reason: 'after_last_leg',
    });
  }
  console.log(JSON.stringify({ fixed }, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
