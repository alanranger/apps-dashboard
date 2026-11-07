const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { sb } = require('../api/mc/_lib');
const { pushSync, reconcileReport } = require('../api/mc/gcal-auto-sync-lib');

async function main() {
  await sb(`scheduling_rules?key=eq.${encodeURIComponent('gcal_push_inflight_until')}`, {
    method: 'PATCH', prefer: 'return=minimal',
    body: { value: '0', updated_at: new Date().toISOString() },
  });
  const flush = await pushSync(sb, 'cursor-flush-pending', { includeRuleMasters: false });
  const fails = (flush.flush?.results || []).filter((r) => !r.ok).slice(0, 20);
  console.log(JSON.stringify({
    planned: flush.flush?.planned,
    applied: flush.flush?.applied,
    failed: flush.flush?.failed,
    fail_sample: fails.map((r) => ({
      summary: r.summary, action: r.action, error: r.error, habit_id: r.habit_id, ideal: r.ideal_date,
    })),
  }, null, 2));
  await sb(`scheduling_rules?key=eq.${encodeURIComponent('gcal_push_inflight_until')}`, {
    method: 'PATCH', prefer: 'return=minimal',
    body: { value: '0', updated_at: new Date().toISOString() },
  });
  const rec = await reconcileReport(sb);
  console.log('reconcile', rec.status_line, 'missing', rec.masters_missing_event_id);
}
main().catch((e) => { console.error(e); process.exit(1); });
