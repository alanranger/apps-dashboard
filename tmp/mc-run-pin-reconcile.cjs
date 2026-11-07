/**
 * Run pin↔GCal reconcile + flush batches (source fix verification).
 * node tmp/mc-run-pin-reconcile.cjs
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { sb } = require('../api/mc/_lib');
const { runDiaryHeal } = require('../api/mc/diary-heal-lib');
const { reconcileReport } = require('../api/mc/gcal-auto-sync-lib');

(async () => {
  console.log('heal+reconcile+flush…');
  const heal = await runDiaryHeal(sb, {
    actor: 'cursor',
    maxOverlaps: 40,
    orphanDays: 200,
    flushAfter: true,
  });
  console.log(JSON.stringify({
    overlaps_fixed: heal.overlaps_fixed,
    orphans_queued: heal.orphans_queued,
    reconcile: heal.reconcile,
    flush: heal.flush,
    push_queued: heal.push_queued,
    remaining_pending: heal.remaining_pending,
  }, null, 2));

  console.log('reconcile report…');
  const report = await reconcileReport(sb);
  console.log(JSON.stringify({
    ok: report.ok,
    status_line: report.status_line,
    mismatch_count: report.mismatch_count,
    mismatches: (report.mismatches || []).slice(0, 15),
    managed_orphans_count: report.managed_orphans_count,
    masters_missing_event_id: report.masters_missing_event_id,
    pending_flush_writes: report.pending_flush_writes,
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
