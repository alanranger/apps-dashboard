/**
 * Fresh reconcile after Push — read-only, never flips flags.
 * node scripts/mc-reconcile-now.cjs
 */
const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '..', '.env.local');
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { sb } = require('../api/mc/_lib');
const { reconcileReport, loadFlags } = require('../api/mc/gcal-auto-sync-lib');

function london(iso) {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London',
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(iso));
  } catch (_) {
    return String(iso);
  }
}

(async () => {
  const flagsBefore = await loadFlags(sb);
  console.log('FLAGS_BEFORE', JSON.stringify(flagsBefore));
  const rec = await reconcileReport(sb);
  const outDir = path.join(__dirname, '..', 'tmp');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'mc-reconcile-post-push-LATEST.json');
  fs.writeFileSync(outPath, JSON.stringify(rec, null, 2));
  console.log('STATUS_LINE', rec.status_line);
  console.log('MISMATCH_COUNT', rec.mismatch_count);
  console.log('CHECKED', rec.checked_count);
  console.log('PENDING_FLUSH', rec.pending_flush_writes);
  console.log('WROTE', outPath);
  for (const m of rec.mismatches || []) {
    console.log([
      m.kind,
      String(m.title || '').slice(0, 60),
      `DB=${london(m.db_start)}`,
      `GCAL=${m.error ? m.error : london(m.gcal_start)}`,
      `t=${m.titleOk} s=${m.startOk} e=${m.endOk}`,
    ].join(' | '));
  }
  console.log('FLAGS_AFTER', JSON.stringify(await loadFlags(sb)));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
