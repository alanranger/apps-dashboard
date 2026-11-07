/**
 * Persist + write rest/away/fixture rule masters.
 *   node tmp/gcal-sync-rule-masters.cjs
 *   node tmp/gcal-sync-rule-masters.cjs --dry
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
for (const line of fs.readFileSync(path.join(root, '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { sb } = require('../api/mc/_lib.js');
const { runRuleEventMasterSync } = require('../api/mc/rule-event-masters-lib.js');

const dry = process.argv.includes('--dry');

(async () => {
  const result = await runRuleEventMasterSync(sb, { writeGcal: !dry, weeks: 52 });
  const out = {
    ran_at: new Date().toISOString(),
    dry,
    ...result,
  };
  const p = path.join(__dirname, 'gcal-sync-rule-masters-LATEST.json');
  fs.writeFileSync(p, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ wrote: p, dry, rest: result.rest, away: result.away, fixtures: result.fixtures }, null, 2));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
