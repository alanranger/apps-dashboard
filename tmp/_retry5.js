const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '..', '.env.local');
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { sb } = require('../api/mc/_lib');
const { getPrimaryEvent, patchPrimaryEvent, verifyPrimaryEvent } = require('../api/mc/gcal-write-lib');
const { reconcileReport, loadFlags } = require('../api/mc/gcal-auto-sync-lib');
const r = require('./mc-title-normalise-LATEST.json');

(async () => {
  for (const m of r.remaining_mismatches || []) {
    const live = await getPrimaryEvent(m.event_id);
    console.log('---');
    console.log('id', m.event_id);
    console.log('DB ', JSON.stringify(m.title));
    console.log('GCAL', JSON.stringify(live.summary));
    await patchPrimaryEvent(m.event_id, { summary: m.title });
    const v = await verifyPrimaryEvent(m.event_id, {
      summary: m.title,
      startIso: m.db_start,
      endIso: m.db_end,
    });
    console.log('retry ok', v.ok, 'live', JSON.stringify(v.live?.summary));
  }
  const after = await reconcileReport(sb);
  console.log('AFTER2', after.status_line, after.mismatch_count);
  for (const m of after.mismatches || []) {
    const live = await getPrimaryEvent(m.event_id);
    console.log('still', JSON.stringify(m.title), 'vs', JSON.stringify(live.summary), m.event_id);
  }
  console.log('FLAGS', JSON.stringify(await loadFlags(sb)));
  fs.writeFileSync(
    path.join(__dirname, 'mc-title-normalise-LATEST.json'),
    JSON.stringify({ ...r, after_retry_status: after.status_line, after_retry_mismatches: after.mismatches }, null, 2),
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
