/**
 * Run habit placer over habit_horizon_weeks in 8w chunks, then flush GCal.
 * node scripts/mc-run-placer-horizon.cjs
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { sb } = require('../api/mc/_lib');
const { runPlacerWindow, addDaysYmd } = require('../api/mc/habit-placer-window-lib');
const { pushSync, loadFlags } = require('../api/mc/gcal-auto-sync-lib');

function todayYmd() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
}

(async () => {
  const today = todayYmd();
  const rules = await sb('scheduling_rules?key=eq.habit_horizon_weeks&select=value');
  const totalWeeks = Number(rules?.[0]?.value || 26);
  const chunk = 8;
  const windows = [];
  for (let w = 0; w < totalWeeks; w += chunk) {
    const from = addDaysYmd(today, w * 7);
    const to = addDaysYmd(today, Math.min(w + chunk, totalWeeks) * 7);
    console.log('placer window', from, '→', to);
    const placer = await runPlacerWindow(sb, from, to, { phaseAnchorYmd: today });
    windows.push(placer);
    console.log(JSON.stringify(placer));
  }

  await sb(`scheduling_rules?key=eq.${encodeURIComponent('gcal_push_inflight_until')}`, {
    method: 'PATCH', prefer: 'return=minimal',
    body: { value: '0', updated_at: new Date().toISOString() },
  }).catch(() => {});

  console.log('flags', await loadFlags(sb));
  let totalApplied = 0;
  let totalFailed = 0;
  for (let i = 0; i < 8; i += 1) {
    const flush = await pushSync(sb, 'cursor-placer-horizon', {
      includeBacklog: true,
      includeRuleMasters: true,
    });
    const applied = flush.flush?.applied || 0;
    const failed = flush.flush?.failed || 0;
    const planned = flush.flush?.planned || 0;
    totalApplied += applied;
    totalFailed += failed;
    console.log('flush pass', i + 1, { planned, applied, failed });
    if (!planned && !applied) break;
  }

  const pending = await sb(
    'gcal_push_queue?status=eq.pending&select=id&limit=50',
  );
  console.log(JSON.stringify({
    windows,
    totalApplied,
    totalFailed,
    still_pending: (pending || []).length,
  }, null, 2));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
