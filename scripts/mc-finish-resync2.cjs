/**
 * Finish Upload gaps + drain push queue with stable phase anchor.
 * node scripts/mc-finish-resync2.cjs
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { sb } = require('../api/mc/_lib');
const { runPlacerWindow } = require('../api/mc/habit-placer-window-lib');
const { pushSync, loadFlags } = require('../api/mc/gcal-auto-sync-lib');
const { idealsInHorizon } = require('../api/mc/rrule-core');

const ANCHOR = '2026-07-30';

(async () => {
  console.log('Upload ideals', idealsInHorizon(
    'FREQ=WEEKLY;INTERVAL=8;BYDAY=WE', ANCHOR, '2027-02-15', 200, ANCHOR,
  ));

  const windows = [
    ['2026-08-01', '2026-09-15'],
    ['2026-10-01', '2026-11-15'],
    ['2026-12-01', '2027-01-15'],
    ['2027-01-20', '2027-02-28'],
  ];
  for (const [from, to] of windows) {
    const placer = await runPlacerWindow(sb, from, to, { phaseAnchorYmd: ANCHOR });
    console.log('placer', {
      from, to,
      pending_wrote: placer.pending_wrote,
      unplaced: placer.unplaced,
      create: placer.create,
      move: placer.move,
      keep: placer.keep,
      delete: placer.delete,
      proof_ok: placer.proof_ok,
    });
  }

  await sb(`scheduling_rules?key=eq.${encodeURIComponent('gcal_push_inflight_until')}`, {
    method: 'PATCH', prefer: 'return=minimal',
    body: { value: '0', updated_at: new Date().toISOString() },
  }).catch(() => {});

  console.log('flags', await loadFlags(sb));
  for (let i = 1; i <= 6; i += 1) {
    const flush = await pushSync(sb, `cursor-finish2-${i}`, {
      includeBacklog: true,
      includeRuleMasters: false,
    });
    const planned = flush.flush?.planned ?? 0;
    const applied = flush.flush?.applied ?? 0;
    const failed = flush.flush?.failed ?? 0;
    console.log(`flush ${i}`, { planned, applied, failed });
    if (planned === 0 && applied === 0) break;
  }

  const pending = await sb(
    'gcal_push_queue?status=eq.pending&select=id,summary,change_kind,payload,updated_at&order=updated_at.desc&limit=10',
  );
  console.log('still_pending', pending);

  const upload = await sb(
    "recurring_tasks?select=id,title&title=ilike.*Upload*",
  );
  const tid = upload?.[0]?.id;
  if (tid) {
    const logs = await sb(
      `recurring_log?recurring_task_id=eq.${tid}&ideal_date=gte.2026-07-30&ideal_date=lte.2027-03-01&select=ideal_date,scheduled_date,change,calendar_event_id,at&order=ideal_date.asc,at.desc`,
    );
    const latest = new Map();
    for (const row of logs || []) {
      if (!latest.has(row.ideal_date)) latest.set(row.ideal_date, row);
    }
    console.log('upload_latest', [...latest.values()]);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
