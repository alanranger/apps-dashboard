/**
 * Clean-sweep rebuild runner.
 *   node tmp/gcal-clean-sweep-rebuild.cjs              # snapshot only
 *   node tmp/gcal-clean-sweep-rebuild.cjs --apply      # delete + recreate + verify
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
for (const line of fs.readFileSync(path.join(root, '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { sb } = require('../api/mc/_lib.js');
const {
  defaultHorizon, loadDbMasters, snapshotPrimaryMc, deleteManaged, recreateFromDb,
} = require('../api/mc/gcal-rebuild-lib.js');
const { fetchHorizonEvents } = require('../api/mc/gcal-lib.js');
const { verifyPrimaryEvent } = require('../api/mc/gcal-write-lib.js');
const { addDaysYmd } = require('../api/mc/diary-lib.js');

const apply = process.argv.includes('--apply');

async function finalDiff(masters, timeMin, timeMax) {
  const { events } = await fetchHorizonEvents(timeMin, timeMax);
  const byId = new Map((events || []).filter((e) => e._calendarId === 'primary').map((e) => [e.id, e]));
  const mismatches = [];
  const missing = [];
  for (const m of masters) {
    const id = m.new_event_id || m.event_id;
    if (!id) { missing.push(m); continue; }
    const v = await verifyPrimaryEvent(id, {
      summary: m.title, startIso: m.start, endIso: m.end,
    });
    if (!v.ok) mismatches.push({ ...m, event_id: id, verify: v });
  }
  return {
    masters: masters.length,
    missing: missing.length,
    mismatches: mismatches.length,
    mismatch_samples: mismatches.slice(0, 20),
    gcal_primary_count: byId.size,
  };
}

async function main() {
  const hz = defaultHorizon();
  const { masters, ruleMap, referencedIds } = await loadDbMasters(sb, hz.from, hz.to);
  const snap = await snapshotPrimaryMc(hz.timeMin, hz.timeMax, referencedIds, ruleMap);
  const out = {
    mode: apply ? 'apply' : 'snapshot_only',
    horizon: hz,
    masters_count: masters.length,
    masters_by_kind: {
      task: masters.filter((m) => m.kind === 'task').length,
      habit: masters.filter((m) => m.kind === 'habit').length,
      travel: masters.filter((m) => m.kind === 'travel').length,
    },
    snapshot: {
      primary_events: snap.count,
      to_delete: snap.to_delete.length,
      left_protected: snap.left_protected.length,
      left_uncertain: snap.left_uncertain.map((r) => ({
        id: r.id, summary: r.summary, start: r.start,
      })),
      left_other: snap.left_other.length,
    },
  };

  const snapPath = path.join(__dirname, 'gcal-clean-sweep-snapshot-LATEST.json');
  fs.writeFileSync(snapPath, JSON.stringify({ ...out, snapshot_rows: snap.rows }, null, 2));
  console.log(JSON.stringify({ wrote: snapPath, ...out.snapshot, masters: out.masters_count }, null, 2));

  if (!apply) {
    console.log('Dry snapshot only. Re-run with --apply to delete+recreate.');
    return;
  }

  const del = await deleteManaged(snap);
  const re = await recreateFromDb(sb, masters);
  for (const c of re.created) {
    const m = masters.find((x) => x.kind === c.kind && x.db_id === c.db_id
      && x.start === c.start);
    if (m) m.new_event_id = c.event_id;
  }
  const diff = await finalDiff(
    re.created.map((c) => ({ ...c, title: c.title, start: c.start, end: c.end, event_id: c.event_id })),
    hz.timeMin,
    hz.timeMax,
  );

  const report = {
    ...out,
    deleted: del,
    recreate: { created_count: re.created_count, failed_count: re.failed_count, failed: re.failed },
    verify: diff,
    aligned: diff.mismatches === 0 && re.failed_count === 0 && del.failed.length === 0,
  };
  const reportPath = path.join(__dirname, 'gcal-clean-sweep-rebuild-LATEST.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    wrote: reportPath,
    deleted: del.deleted_count,
    created: re.created_count,
    failed: re.failed_count,
    verify_mismatches: diff.mismatches,
    aligned: report.aligned,
    left_uncertain: out.snapshot.left_uncertain.length,
  }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
