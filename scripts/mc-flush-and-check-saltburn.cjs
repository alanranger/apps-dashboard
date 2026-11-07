const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { sb } = require('../api/mc/_lib');
const { getPrimaryEvent } = require('../api/mc/gcal-write-lib');
const { pushSync, reconcileReport } = require('../api/mc/gcal-auto-sync-lib');

async function main() {
  await sb(`scheduling_rules?key=eq.${encodeURIComponent('gcal_push_inflight_until')}`, {
    method: 'PATCH', prefer: 'return=minimal',
    body: { value: '0', updated_at: new Date().toISOString() },
  });
  const ev = await getPrimaryEvent('q77gc16vr0s9r555if6kd89f1g');
  console.log('saltburn_gcal', JSON.stringify({ summary: ev.summary, start: ev.start, end: ev.end }));
  const flush = await pushSync(sb, 'cursor-convergence', { includeRuleMasters: false });
  console.log('flush', { planned: flush.flush?.planned, applied: flush.flush?.applied, failed: flush.flush?.failed });
  await sb(`scheduling_rules?key=eq.${encodeURIComponent('gcal_push_inflight_until')}`, {
    method: 'PATCH', prefer: 'return=minimal',
    body: { value: '0', updated_at: new Date().toISOString() },
  });
  const rec = await reconcileReport(sb);
  console.log('reconcile', rec.status_line, 'missing', rec.masters_missing_event_id, 'orphans', rec.managed_orphans_count);
  console.log('mismatch_sample', JSON.stringify((rec.mismatches || []).slice(0, 8), null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
