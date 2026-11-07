/**
 * Phase 3 mandatory dry-run first pass (no writes).
 *   node tmp/gcal-auto-sync-dry-run.cjs
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
for (const line of fs.readFileSync(path.join(root, '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { sb } = require('../api/mc/_lib.js');
const { dryRunSync, reconcileReport } = require('../api/mc/gcal-auto-sync-lib.js');

(async () => {
  const dry = await dryRunSync(sb);
  const reconcile = await reconcileReport(sb);
  const out = {
    ran_at: new Date().toISOString(),
    phase: 'phase3_dry_run_first_pass',
    auto_sync_will_write: false,
    note: 'Awaiting Alan sign-off. auto_sync_enabled=false, auto_sync_signed_off=false.',
    dry,
    reconcile,
  };
  const p = path.join(__dirname, 'gcal-auto-sync-dry-run-LATEST.json');
  fs.writeFileSync(p, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({
    wrote: p,
    flags: dry.flags,
    pending_writes: dry.flush.write_count,
    sample: dry.flush.writes.slice(0, 15),
    reconcile_pending_flush: reconcile.pending_flush_writes,
    masters_missing_event_id: reconcile.masters_missing_event_id,
  }, null, 2));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
