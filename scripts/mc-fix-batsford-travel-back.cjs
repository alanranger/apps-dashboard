/**
 * Heal Batsford travel_back to workshop end; debug DB vs Google.
 * node scripts/mc-fix-batsford-travel-back.cjs
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { sb } = require('../api/mc/_lib');
const { fetchHorizonEvents } = require('../api/mc/gcal-lib');
const { getPrimaryEvent, patchPrimaryEvent } = require('../api/mc/gcal-write-lib');
const { ruleMapFromRows } = require('../api/mc/scheduling-rules-lib');
const { planTravelRegenerate } = require('../api/mc/travel-regenerate-lib');
const { londonToday, addDaysYmd } = require('../api/mc/diary-lib');
const { travelGcalTitle, travelGcalLocation, travelGcalDescription } = require('../api/mc/gcal-title-lib');

async function main() {
  const today = londonToday();
  const [blocks, rules, venues, gcal] = await Promise.all([
    sb('travel_blocks?select=*&block_type=in.(travel_out,travel_back)&order=starts_at.asc'),
    sb('scheduling_rules?select=key,value'),
    sb('venue_drive_times?select=venue_name,minutes_from_home'),
    fetchHorizonEvents(`${addDaysYmd(today, -14)}T00:00:00.000Z`, `${addDaysYmd(today, 400)}T00:00:00.000Z`),
  ]);
  const ruleMap = ruleMapFromRows(rules || []);
  const plan = planTravelRegenerate(blocks || [], gcal.events || [], ruleMap, venues || []);
  const prefixes = { travel: ruleMap.title_prefix_travel || 'MC 🚗' };
  let applied = 0;
  for (const row of plan.changes || []) {
    for (const leg of ['out', 'back']) {
      if (!row[leg].changed) continue;
      await sb(`travel_blocks?id=eq.${row[leg].id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: {
          starts_at: row[leg].to.starts_at,
          ends_at: row[leg].to.ends_at,
          workshop_start: row.workshop_live_start,
          workshop_row_key: row.workshop_row_key,
          workshop_title: row.title,
          drive_minutes_used: row.drive_minutes,
        },
      });
      if (row[leg].calendar_event_id) {
        const db = (blocks || []).find((b) => b.id === row[leg].id) || {};
        const block = {
          block_type: leg === 'out' ? 'travel_out' : 'travel_back',
          venue_name: row.venue,
          workshop_title: row.title,
          leg_from: db.leg_from,
          leg_to: db.leg_to,
          drive_minutes_used: row.drive_minutes,
        };
        await patchPrimaryEvent(row[leg].calendar_event_id, {
          summary: travelGcalTitle(block, prefixes),
          location: travelGcalLocation(block),
          description: travelGcalDescription(block),
          startIso: row[leg].to.starts_at,
          endIso: row[leg].to.ends_at,
        });
      }
      applied += 1;
      if (/batsford/i.test(row.title || '')) {
        console.log('healed', leg, row.title.slice(0, 50), row[leg].from, '->', row[leg].to);
      }
    }
  }
  console.log('applied', applied);

  const rows = (await sb(
    'travel_blocks?select=id,starts_at,ends_at,calendar_event_id,workshop_title'
    + '&block_type=eq.travel_back&order=starts_at.asc',
  ) || []).filter((r) => /batsford/i.test(r.workshop_title || '') && /6 of 6/i.test(r.workshop_title || ''));
  console.log('db 6of6', rows);

  const { events } = await fetchHorizonEvents('2026-10-31T00:00:00.000Z', '2026-11-01T00:00:00.000Z');
  for (const e of events) {
    const t = e.summary || '';
    if (!/Travel|Batsford|Hull|⚽|Ipswich/i.test(t)) continue;
    console.log(e.start?.dateTime || e.start?.date, '->', e.end?.dateTime || e.end?.date, '|', t.slice(0, 70), '|', e.id);
  }

  for (const r of rows) {
    if (!r.calendar_event_id) continue;
    const g = await getPrimaryEvent(r.calendar_event_id);
    console.log('readback', r.calendar_event_id, g?.start, g?.end, g?.summary);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
