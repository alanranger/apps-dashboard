/**
 * Heal orphan workshop travel (+ AWAY) when parent moved/cancelled.
 * Uses workshop-travel-reconcile-lib then rule-event master sync.
 *
 * node scripts/mc-heal-orphan-workshop-travel.cjs
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { sb } = require('../api/mc/_lib');
const { fetchHorizonEvents } = require('../api/mc/gcal-lib');
const { londonToday, addDaysYmd } = require('../api/mc/diary-lib');
const { runWorkshopTravelReconcile } = require('../api/mc/workshop-travel-reconcile-lib');
const { runRuleEventMasterSync } = require('../api/mc/rule-event-masters-lib');

async function main() {
  const today = londonToday();
  const horizonEnd = addDaysYmd(today, 90);
  const notes = [];
  const { events } = await fetchHorizonEvents(
    `${today}T00:00:00Z`,
    `${horizonEnd}T23:59:59Z`,
  );
  const stats = await runWorkshopTravelReconcile({
    sb,
    gcalEvents: events || [],
    today,
    horizonEnd,
    notes,
  });
  let away = null;
  if (stats.deleted > 0) {
    away = await runRuleEventMasterSync(sb, { writeGcal: true, weeks: 16 });
  }
  console.log(JSON.stringify({ today, horizonEnd, stats, notes, away }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
