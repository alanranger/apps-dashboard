/**
 * Diagnose missing prep/decompress (8 Sep 1-2-1) and Arsenal flanks (15 Sep).
 * node tmp/diagnose-flanks-sep.cjs
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { sb } = require('../api/mc/_lib');
const { isOnlineClientHome } = require('../api/mc/scheduleCsv');
const { isClientParent } = require('../api/mc/client-buffer-reconcile-lib');

const fixId = '6a8f62f254aa88426515c5ae';
const palaceId = '6a3507b354aa8848aa0a949d';
const clientTitle = 'jackie evans: 2hr 1-2-1 Anytime Private (Alan Ranger Photography)';

(async () => {
  const rows = await sb(
    `fixture_blocks?select=*&or=(fixture_event_id.eq.${fixId},fixture_event_id.eq.${palaceId},title.ilike.*Arsenal*,title.ilike.*Crystal*)`,
  );
  const pendingArsenal = await sb(
    'pending_diary_changes?select=id,change_type,status,target_date,summary,related_id,resolved_at,resolved_by'
    + `&or=(related_id.ilike.*${fixId}*,summary.ilike.*Arsenal*)&order=target_date.desc&limit=20`,
  );
  const recentFix = await sb(
    'pending_diary_changes?change_type=eq.fixture_block&select=id,status,target_date,summary,related_id,resolved_at,resolved_by'
    + '&order=target_date.desc&limit=25',
  );
  const pending121 = await sb(
    'pending_diary_changes?select=id,change_type,status,target_date,summary,related_id'
    + '&or=(summary.ilike.*jackie*,summary.ilike.*Anytime%20Private*,related_id.ilike.*d53ckr70*)&order=target_date.desc&limit=10',
  );
  const activePendingFix = await sb(
    'pending_diary_changes?change_type=eq.fixture_block&status=eq.pending&select=id,target_date,summary,related_id'
    + '&order=target_date.asc&limit=30',
  );

  console.log(JSON.stringify({
    client_classifier: {
      title: clientTitle,
      isOnlineClientHome: isOnlineClientHome(clientTitle),
      isClientParent: isClientParent({
        summary: clientTitle,
        start: { dateTime: '2026-09-08T10:00:00+01:00' },
      }),
    },
    fixture_rows: rows,
    pending_arsenal: pendingArsenal,
    pending_121: pending121,
    active_pending_fixture: activePendingFix,
    recent_fixture_pending: recentFix,
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
