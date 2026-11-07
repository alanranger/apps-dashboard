/**
 * Dry-run: show Saltburn / deferred residential travel after local-teaching fix.
 * node scripts/mc-dry-saltburn-travel.cjs
 */
const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '..', '.env.local');
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { sb } = require('../api/mc/_lib');
const { ruleMapFromRows } = require('../api/mc/scheduling-rules-lib');
const { fetchHorizonEvents } = require('../api/mc/gcal-lib');
const { planTravelRegenerate } = require('../api/mc/travel-regenerate-lib');

async function main() {
  const [blocks, rules, venues, gcal] = await Promise.all([
    sb('travel_blocks?select=*&block_type=in.(travel_out,travel_back)&order=starts_at.asc'),
    sb('scheduling_rules?select=key,value'),
    sb('venue_drive_times?select=venue_name,minutes_from_home'),
    fetchHorizonEvents('2026-09-01T00:00:00.000Z', '2026-09-20T00:00:00.000Z'),
  ]);
  const plan = planTravelRegenerate(
    blocks || [],
    gcal.events || [],
    ruleMapFromRows(rules || []),
    venues || [],
  );
  const salt = (plan.linked || []).filter((c) =>
    /saltburn|ellerby|yorkshire coast/i.test(`${c.venue} ${c.title}`));
  const deferred = (plan.changes || []).filter((c) => c.deferred_for_local_teaching);
  console.log(JSON.stringify({
    salt,
    deferred_count: deferred.length,
    deferred: deferred.map((c) => ({
      venue: c.venue,
      mode: c.mode,
      from: c.out.from,
      to: c.out.to,
    })),
  }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
