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
const { awaySpansFromTravelBlocks } = require('../api/mc/habit-placer-lib.js');

const travel = await sb(
  'travel_blocks?select=block_type,starts_at,ends_at,venue_name,workshop_title,workshop_start,workshop_row_key'
  + '&block_type=in.(travel_out,travel_back)'
  + '&starts_at=gte.2026-08-01T00:00:00Z&starts_at=lte.2026-09-05T23:59:59Z',
);
const spans = awaySpansFromTravelBlocks(travel || []);
console.log(JSON.stringify(spans.map((s) => ({
  start: s.startDay, end: s.endDay, summary: s.summary,
})), null, 2));
for (const d of ['2026-08-16', '2026-08-17', '2026-08-22', '2026-08-23', '2026-08-24']) {
  const hit = spans.find((s) => d >= s.startDay && d <= s.endDay);
  console.log(d, hit ? `AWAY span: ${hit.summary}` : 'not in travel away span');
}
