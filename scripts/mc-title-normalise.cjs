/**
 * Title-only normalise: patch Google titles to DB canonical where times already match.
 * Never changes times. Never flips auto_sync flags.
 * node scripts/mc-title-normalise.cjs
 */
const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '..', '.env.local');
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { sb } = require('../api/mc/_lib');
const { patchPrimaryEvent, verifyPrimaryEvent } = require('../api/mc/gcal-write-lib');
const { reconcileReport, loadFlags } = require('../api/mc/gcal-auto-sync-lib');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const flagsBefore = await loadFlags(sb);
  console.log('FLAGS_BEFORE', JSON.stringify(flagsBefore));
  if (flagsBefore.auto_sync_enabled || flagsBefore.auto_sync_signed_off) {
    console.error('ABORT: flags unexpectedly on');
    process.exit(2);
  }

  console.log('Running reconcile to collect title-only drifts…');
  const before = await reconcileReport(sb);
  const titleOnly = (before.mismatches || []).filter(
    (m) => m.event_id && m.title && m.titleOk === false && m.startOk === true && m.endOk === true,
  );
  console.log('BEFORE', before.status_line, 'title_only_candidates', titleOnly.length);

  const results = [];
  for (const m of titleOnly) {
    const row = {
      event_id: m.event_id,
      expect_title: m.title,
      kind: m.kind,
      db_start: m.db_start,
    };
    try {
      await patchPrimaryEvent(m.event_id, { summary: m.title });
      const v = await verifyPrimaryEvent(m.event_id, {
        summary: m.title,
        startIso: m.db_start,
        endIso: m.db_end,
      });
      if (!v.ok) {
        row.ok = false;
        row.error = 'readback_mismatch';
        row.verify = v;
        console.log('FAIL', m.event_id, (m.title || '').slice(0, 50), JSON.stringify(v.live?.summary));
      } else {
        row.ok = true;
        console.log('OK', (m.title || '').slice(0, 55));
      }
    } catch (e) {
      row.ok = false;
      row.error = e.message;
      console.log('ERR', m.event_id, e.message);
    }
    results.push(row);
    await sleep(80);
  }

  console.log('Re-running reconcile…');
  const after = await reconcileReport(sb);
  const out = {
    generated_at: new Date().toISOString(),
    flags_before: flagsBefore,
    flags_after: await loadFlags(sb),
    before_status: before.status_line,
    after_status: after.status_line,
    title_only_attempted: titleOnly.length,
    patched_ok: results.filter((r) => r.ok).length,
    patched_failed: results.filter((r) => !r.ok).length,
    remaining_mismatches: after.mismatches || [],
    results,
  };
  const outDir = path.join(__dirname, '..', 'tmp');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'mc-title-normalise-LATEST.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log('AFTER', after.status_line);
  console.log('remaining', after.mismatch_count);
  for (const m of after.mismatches || []) {
    console.log(
      m.kind,
      (m.title || '').slice(0, 50),
      `t=${m.titleOk} s=${m.startOk} e=${m.endOk}`,
      m.error || '',
    );
  }
  console.log('WROTE', outPath);
  console.log('FLAGS_AFTER', JSON.stringify(out.flags_after));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
