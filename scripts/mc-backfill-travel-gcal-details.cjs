/**
 * Backfill location + description on all MC travel GCal events from travel_blocks.
 * node scripts/mc-backfill-travel-gcal-details.cjs [--dry-run]
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
const { ruleMapFromRows } = require('../api/mc/scheduling-rules-lib');

async function main() {
  const dry = process.argv.includes('--dry-run');
  const [blocks, rules] = await Promise.all([
    sb('travel_blocks?select=*&calendar_event_id=not.is.null&order=starts_at.asc'),
    sb('scheduling_rules?select=key,value'),
  ]);
  const ruleMap = ruleMapFromRows(rules || []);
  const prefixes = {
    travel: ruleMap.title_prefix_travel || 'MC 🚗',
    buffer: ruleMap.title_prefix_buffer || 'MC ⏳',
  };
  let updated = 0;
  const failed = [];
  for (const row of blocks || []) {
    const summary = travelGcalTitle(row, prefixes);
    const location = travelGcalLocation(row);
    const description = travelGcalDescription(row);
    if (dry) {
      if (updated < 3) {
        console.log(JSON.stringify({
          id: row.id, summary, location, description, event: row.calendar_event_id,
        }));
      }
      updated += 1;
      continue;
    }
    try {
      await patchPrimaryEvent(row.calendar_event_id, {
        summary,
        location,
        description,
        startIso: row.starts_at,
        endIso: row.ends_at,
      });
      const v = await verifyPrimaryEvent(row.calendar_event_id, {
        summary,
        startIso: row.starts_at,
        endIso: row.ends_at,
      });
      if (!v.ok) failed.push({ id: row.id, error: 'readback_mismatch' });
      else updated += 1;
      await new Promise((r) => setTimeout(r, 40));
    } catch (e) {
      failed.push({ id: row.id, error: e.message });
    }
  }
  console.log(JSON.stringify({ dry, scanned: (blocks || []).length, updated, failed }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
