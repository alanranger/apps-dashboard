/**
 * Re-run habit placer with always-schedule policy (DB + push queue only).
 * node scripts/mc-replace-unplaced.cjs
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { sb } = require('../api/mc/_lib');
const { fetchHorizonEvents } = require('../api/mc/gcal-lib');
const { ruleMapFromRows, addDays } = require('../api/mc/scheduling-rules-lib');
const { runHabitPlacerPropose } = require('../api/mc/habit-placer-propose-lib');

(async () => {
  const rules = await sb('scheduling_rules?select=key,value');
  const ruleMap = ruleMapFromRows(rules || []);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
  const weeks = Number(ruleMap.habit_horizon_weeks || 26);
  const toYmd = addDays(today, weeks * 7);
  const { events } = await fetchHorizonEvents(`${today}T00:00:00.000Z`, `${toYmd}T23:59:59.000Z`);
  const bh = await sb(`bank_holidays?select=holiday_date&holiday_date=gte.${today}&holiday_date=lte.${toYmd}`) || [];
  const holidays = new Set(bh.map((r) => r.holiday_date));
  const inserted = [];
  const result = await runHabitPlacerPropose({
    sb,
    ruleMap,
    holidays,
    fromYmd: today,
    toYmd,
    gcalEvents: events || [],
    existingPending: async () => false,
    inserted,
    writePending: true,
  });
  console.log(JSON.stringify({
    today,
    toYmd,
    placements: (result.placements || []).length,
    unplaced: (result.unplaced || []).length,
    unplaced_sample: (result.unplaced || []).slice(0, 15),
    habit_db_applied: result.habit_db_applied,
    amendment_counts: result.amendment_counts,
    proof: result.proof?.ok,
  }, null, 2));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
