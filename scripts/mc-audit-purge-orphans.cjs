/**
 * Audit + purge MC Primary orphans (manual / ops).
 * Dry-run: node scripts/mc-audit-purge-orphans.cjs
 * Apply:   node scripts/mc-audit-purge-orphans.cjs --fix
 *
 * Production cron: /api/cron/gcal-auto-sync runs purgeUntiedMcOrphansDaily once/day.
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const FIX = process.argv.includes('--fix');
const { sb } = require('../api/mc/_lib');
const { fetchHorizonEvents } = require('../api/mc/gcal-lib');
const {
  collectClaimedIds, listUntiedOrphans, purgeUntiedMcOrphans,
} = require('../api/mc/gcal-orphan-purge-lib');
const { londonToday, addDaysYmd } = require('../api/mc/diary-lib');
const { isoToLondonDate } = require('../api/mc/scheduling-rules-lib');

async function main() {
  const today = londonToday();
  const from = addDaysYmd(today, -21);
  const to = addDaysYmd(today, 280);
  console.log(JSON.stringify({ mode: FIX ? 'FIX' : 'DRY_RUN', from, to }, null, 2));

  const [claimed, snap] = await Promise.all([
    collectClaimedIds(sb),
    fetchHorizonEvents(`${from}T00:00:00.000Z`, `${to}T00:00:00.000Z`),
  ]);
  const orphans = listUntiedOrphans(snap.events || [], claimed);
  console.log('\n=== ORPHANS ===');
  console.log('count', orphans.length);
  for (const o of orphans) {
    console.log(o.day, String(o.start || '').slice(11, 16), String(o.summary || '').slice(0, 80));
  }

  const bg = (snap.events || []).filter((e) => (e._calendarId || 'primary') === 'primary'
    && /Bank Genie|Monthly Accounts/i.test(e.summary || ''));
  console.log('\n=== Bank Genie ===');
  for (const e of bg.sort((a, b) => a.start.dateTime.localeCompare(b.start.dateTime))) {
    console.log(
      isoToLondonDate(e.start.dateTime),
      claimed.has(e.id) ? 'CLAIMED' : 'ORPHAN',
      String(e.summary || '').slice(0, 60),
    );
  }

  if (!FIX) {
    console.log(JSON.stringify({
      mode: 'DRY_RUN', orphans: orphans.length, tip: 'Re-run with --fix',
    }, null, 2));
    return;
  }
  const result = await purgeUntiedMcOrphans(sb, { events: snap.events, limit: 200 });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
