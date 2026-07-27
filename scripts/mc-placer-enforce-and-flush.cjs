/**
 * Enforce hard constraints via placer, apply DB+queue, flush Google, reconcile.
 * node scripts/mc-placer-enforce-and-flush.cjs
 */
const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '..', '.env.local');
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { sb } = require('../api/mc/_lib');
const { fetchHorizonEvents } = require('../api/mc/gcal-lib');
const { runHabitPlacerPropose } = require('../api/mc/habit-placer-propose-lib');
const { ruleMapFromRows, bankHolidaySet, addDays } = require('../api/mc/scheduling-rules-lib');
const { londonToday } = require('../api/mc/diary-lib');
const { pushSync, reconcileReport, loadFlags } = require('../api/mc/gcal-auto-sync-lib');

(async () => {
  const flags = await loadFlags(sb);
  console.log('FLAGS', flags);
  const today = londonToday();
  const fromYmd = today;
  const toYmd = addDays(today, 180);
  const rules = await sb('scheduling_rules?select=key,value');
  const ruleMap = ruleMapFromRows(rules || []);
  const holidays = bankHolidaySet(ruleMap);
  const { events } = await fetchHorizonEvents(
    `${addDays(fromYmd, -14)}T00:00:00.000Z`,
    `${toYmd}T23:59:59.000Z`,
  );

  const result = await runHabitPlacerPropose({
    sb,
    ruleMap,
    holidays,
    fromYmd,
    toYmd,
    gcalEvents: events || [],
    existingPending: async () => false,
    inserted: [],
    writePending: true,
  });

  const moves = (result.amendments || []).filter((a) => a.action === 'MOVE' || a.action === 'CREATE');
  const report = {
    generated_at: new Date().toISOString(),
    fromYmd,
    toYmd,
    proof: result.proof,
    amendment_counts: result.amendment_counts,
    habit_db_applied: result.habit_db_applied,
    task_db_applied: result.task_db_applied,
    task_bump_scheduled: result.task_bump_scheduled,
    task_bump_unplaced: result.task_bump_unplaced,
    unplaced_habits: result.unplaced,
    changes: moves.map((a) => ({
      action: a.action,
      title: a.title,
      ideal: a.ideal_date,
      from: a.from_startIso || null,
      to: `${a.startIso} – ${a.endIso}`,
    })),
    bumps: (result.task_bumps || []).filter((b) => b.new_start).map((b) => ({
      display_id: b.display_id,
      reason: b.reason,
      from: b.task_start,
      to: b.new_start,
      day: b.new_day,
      unplaced: !!b.unplaced,
    })),
    bumps_unplaced: (result.task_bumps || []).filter((b) => b.unplaced),
  };

  console.log('proof.ok', result.proof?.ok, 'fails', (result.proof?.fails || []).slice(0, 20));
  console.log('amendments', result.amendment_counts);
  console.log('habit_db_applied', result.habit_db_applied, 'task_db_applied', result.task_db_applied);
  console.log('changes', report.changes.length);

  // If proof failed, still try flush of whatever was queued from partial apply
  console.log('Flushing push queue…');
  const flush = await pushSync(sb, 'cursor', { includeBacklog: false, includeRuleMasters: false });
  report.flush = {
    planned: flush.flush?.planned,
    applied: flush.flush?.applied,
    failed: flush.flush?.failed,
  };
  console.log('flush', report.flush);

  const rec = await reconcileReport(sb);
  report.reconcile = {
    status_line: rec.status_line,
    mismatch_count: rec.mismatch_count,
    google_matches_db: rec.google_matches_db,
  };
  console.log('reconcile', report.reconcile);
  console.log('FLAGS_AFTER', await loadFlags(sb));

  const outPath = path.join(__dirname, '..', 'tmp', 'mc-placer-enforce-LATEST.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log('WROTE', outPath);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
