/**
 * Re-sync AWAY masters to full travel-out → travel-back inclusive days.
 * Usage: node scripts/mc-resync-away-full-span.cjs
 */
const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '..', '.env.local');
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([^#=]+)=(.*)$/);
  if (!m) continue;
  const k = m[1].trim();
  let v = m[2].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  if (!process.env[k]) process.env[k] = v;
}
const { sb } = require('../api/mc/_lib');
const { runRuleEventMasterSync } = require('../api/mc/rule-event-masters-lib');
const { awaySpansFromTravelBlocks } = require('../api/mc/habit-placer-lib');

async function main() {
  const travel = await sb('travel_blocks?select=*&order=starts_at.asc');
  const spans = awaySpansFromTravelBlocks(travel || []);
  console.log('derived spans (sample Aug–Sep):');
  for (const s of spans) {
    if (s.startDay >= '2026-08-01' && s.startDay <= '2026-09-20') {
      console.log(`  ${s.startDay}→${s.endDay} ${s.summary}`);
    }
  }
  const sync = await runRuleEventMasterSync(sb, { writeGcal: true, weeks: 52 });
  console.log('away sync', JSON.stringify(sync.away, null, 2));
  const active = await sb(
    'away_day_blocks?status=eq.active&start_date=gte.2026-08-10&start_date=lte.2026-09-20'
    + '&select=start_date,end_date,venue_name,calendar_event_id&order=start_date.asc',
  );
  console.log('active away:', active);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
