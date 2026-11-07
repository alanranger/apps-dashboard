const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { sb } = require('../api/mc/_lib');
const { runPlacerWindow } = require('../api/mc/habit-placer-window-lib');
const { pushSync } = require('../api/mc/gcal-auto-sync-lib');
const { patchPrimaryEvent } = require('../api/mc/gcal-write-lib');

(async () => {
  const today = '2026-07-30';
  // Re-place first window so Upload 26 Aug lands
  console.log('window1', await runPlacerWindow(sb, '2026-07-30', '2026-09-24', { phaseAnchorYmd: today }));
  console.log('window3', await runPlacerWindow(sb, '2026-11-19', '2027-01-14', { phaseAnchorYmd: today }));

  await sb('scheduling_rules?key=eq.gcal_push_inflight_until', {
    method: 'PATCH', prefer: 'return=minimal',
    body: { value: '0', updated_at: new Date().toISOString() },
  }).catch(() => {});

  // Apply stuck MC-20 gap slide directly if still pending
  const pending = await sb(
    "gcal_push_queue?status=eq.pending&select=*&order=updated_at.desc&limit=10",
  );
  for (const row of pending || []) {
    const p = row.payload || {};
    if (p.action === 'patch' && p.event_id && p.startIso && p.endIso) {
      try {
        await patchPrimaryEvent(p.event_id, { startIso: p.startIso, endIso: p.endIso });
        await sb(`gcal_push_queue?id=eq.${row.id}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: {
            status: 'applied',
            resolved_at: new Date().toISOString(),
            resolved_by: 'cursor',
            updated_at: new Date().toISOString(),
          },
        });
        console.log('patched', row.summary);
      } catch (e) {
        console.log('patch fail', row.summary, e.message);
      }
    }
  }

  for (let i = 0; i < 6; i += 1) {
    const f = await pushSync(sb, 'cursor-finish', { includeBacklog: true, includeRuleMasters: true });
    console.log('flush', i + 1, {
      planned: f.flush?.planned, applied: f.flush?.applied, failed: f.flush?.failed,
    });
    if (!(f.flush?.planned || f.flush?.applied)) break;
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
