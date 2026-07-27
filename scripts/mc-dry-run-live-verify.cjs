/**
 * Phase 3 dry-run with live-DB hydration. Never writes. Never flips flags.
 * node scripts/mc-dry-run-live-verify.cjs
 */
const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '..', '.env.local');
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { sb } = require('../api/mc/_lib');
const { dryRunSync, reconcileReport, loadFlags } = require('../api/mc/gcal-auto-sync-lib');

function londonLabel(iso) {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London',
      weekday: 'short', day: '2-digit', month: 'short',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(iso));
  } catch (_) {
    return String(iso);
  }
}

async function main() {
  const flags = await loadFlags(sb);
  console.log('FLAGS (must stay false):', flags);

  const dry = await dryRunSync(sb);
  const outDir = path.join(__dirname, '..', 'tmp');
  fs.mkdirSync(outDir, { recursive: true });
  const dryPath = path.join(outDir, 'mc-dry-run-live-LATEST.json');
  fs.writeFileSync(dryPath, JSON.stringify(dry, null, 2));
  console.log('Wrote', dryPath);
  console.log('live_db_times', dry.flush?.live_db_times, 'writes', dry.flush?.write_count);

  const tasks = await sb(
    'tasks?display_id=in.(1,2,13,51)&select=display_id,title,scheduled_start,scheduled_end,calendar_event_id',
  );
  console.log('\n=== Claude sample tasks: DB vs dry-run ===');
  for (const t of tasks || []) {
    const w = (dry.flush?.writes || []).find(
      (x) => Number(x.display_id) === Number(t.display_id)
        || (x.summary || '').includes(`MC-${t.display_id}`),
    );
    const dbStart = new Date(t.scheduled_start).toISOString();
    const planStart = w?.to?.start || null;
    const match = !planStart || planStart === dbStart
      || Math.abs(Date.parse(planStart) - Date.parse(dbStart)) < 1000;
    console.log(
      `MC-${t.display_id}`,
      match ? 'OK' : 'MISMATCH',
      '| DB', londonLabel(t.scheduled_start),
      '| plan', londonLabel(planStart),
      '| live_from', w?.live_from || '(not in plan)',
    );
  }

  console.log('\n=== Reconcile (read-only) ===');
  const rec = await reconcileReport(sb);
  const recPath = path.join(outDir, 'mc-reconcile-live-LATEST.json');
  fs.writeFileSync(recPath, JSON.stringify(rec, null, 2));
  console.log(rec.status_line);
  console.log('Wrote', recPath);
  console.log('FLAGS after (unchanged expected):', await loadFlags(sb));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
