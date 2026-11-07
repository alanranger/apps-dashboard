import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
for (const line of fs.readFileSync(path.join(root, '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { sb } = require('../api/mc/_lib.js');
const { ruleMapFromRows } = require('../api/mc/scheduling-rules-lib.js');
const { awaySpansFromTravelBlocks, dayBlockedForPlacement } = require('../api/mc/habit-placer-lib.js');

const j = JSON.parse(fs.readFileSync(path.join(root, 'tmp/restday-monday-resolve-LATEST.json'), 'utf8'));
console.log('unplaced', JSON.stringify(j.unplaced_rows, null, 2));
console.log('assertions', JSON.stringify(Object.fromEntries(
  Object.entries(j.assertions).map(([k, v]) => [k, {
    cleared: v.cleared_planned,
    moves: v.move_count,
    issues: v.dest_issues,
    landings: v.landings?.map((l) => `${l.title}→${l.to_day}`),
  }]),
), null, 2));

const rules = await sb('scheduling_rules?select=key,value');
const ruleMap = ruleMapFromRows(rules);
const travel = await sb(
  'travel_blocks?select=block_type,starts_at,ends_at,venue_name,workshop_title,workshop_start,workshop_row_key'
  + '&block_type=in.(travel_out,travel_back)&starts_at=gte.2026-08-01T00:00:00Z&starts_at=lte.2026-12-01T23:59:59Z',
);
const spans = awaySpansFromTravelBlocks(travel || [], ruleMap);
console.log('restDays', spans.filter((s) => s.restDay).map((s) => ({ end: s.endDay, rest: s.restDay, s: s.summary })));
console.log('Nov2 blocked?', dayBlockedForPlacement('2026-11-02', spans));
console.log('Aug17 blocked?', dayBlockedForPlacement('2026-08-17', spans));
