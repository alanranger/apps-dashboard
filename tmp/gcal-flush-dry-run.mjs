/**
 * Dry-run baseline GCal flush + optional write probe.
 * Usage: node tmp/gcal-flush-dry-run.mjs [--probe]
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
for (const line of fs.readFileSync(path.join(root, '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { sb } = require('../api/mc/_lib.js');
const { buildFlushPlan } = require('../api/mc/gcal-flush-lib.js');
const { testWriteRoundTrip } = require('../api/mc/gcal-write-lib.js');

const probe = process.argv.includes('--probe');
const out = { at: new Date().toISOString(), probe: null, plan: null };

if (probe) {
  out.probe = await testWriteRoundTrip();
  console.log('PROBE', JSON.stringify(out.probe, null, 2));
}

out.plan = await buildFlushPlan(sb);
const slim = {
  ...out.plan,
  writes: (out.plan.writes || []).map((w) => ({
    action: w.action,
    entity_type: w.entity_type,
    summary: w.summary,
    event_id: w.event_id,
    from: w.from,
    to: w.to,
    source: w.source,
    note: w.note || null,
  })),
};
fs.writeFileSync(path.join(root, 'tmp/gcal-flush-dry-run-LATEST.json'), JSON.stringify({
  at: out.at, probe: out.probe, ...slim,
}, null, 2));
console.log(JSON.stringify({
  at: out.at,
  probe_ok: out.probe?.ok ?? null,
  queue_raw: slim.queue_raw,
  queue_collapsed: slim.queue_collapsed,
  backlog_rows: slim.backlog_rows,
  write_count: slim.write_count,
  skipped_count: slim.skipped_count,
  by_action: slim.writes.reduce((a, w) => {
    a[w.action] = (a[w.action] || 0) + 1;
    return a;
  }, {}),
}, null, 2));
