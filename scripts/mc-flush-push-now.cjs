/**
 * Flush pending GCal push (including MC-32 complete).
 * node scripts/mc-flush-push-now.cjs
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { sb } = require('../api/mc/_lib');
const { pushSync, loadFlags } = require('../api/mc/gcal-auto-sync-lib');

(async () => {
  console.log('flags', await loadFlags(sb));
  await sb(`scheduling_rules?key=eq.${encodeURIComponent('gcal_push_inflight_until')}`, {
    method: 'PATCH', prefer: 'return=minimal',
    body: { value: '0', updated_at: new Date().toISOString() },
  }).catch(() => {});
  const flush = await pushSync(sb, 'cursor-flush-mc32', { includeBacklog: false, includeRuleMasters: false });
  console.log(JSON.stringify({
    planned: flush.flush?.planned,
    applied: flush.flush?.applied,
    failed: flush.flush?.failed,
    sample: (flush.flush?.results || flush.flush?.applied_rows || []).slice?.(0, 10),
  }, null, 2));
  const pending = await sb(
    "gcal_push_queue?status=eq.pending&select=id,summary,change_kind,payload&order=updated_at.desc&limit=10",
  );
  console.log('still_pending', pending);
})().catch((e) => { console.error(e); process.exit(1); });
