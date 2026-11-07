/**
 * Apply baseline GCal flush (Alan approved).
 * Usage: node tmp/gcal-flush-apply.cjs
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
for (const line of fs.readFileSync(path.join(root, '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { sb } = require('../api/mc/_lib.js');
const { buildFlushPlan, applyFlushPlan } = require('../api/mc/gcal-flush-lib.js');

async function main() {
  const plan = await buildFlushPlan(sb);
  console.log(JSON.stringify({
    phase: 'plan',
    write_count: plan.write_count,
    skipped_count: plan.skipped_count,
    queue_collapsed: plan.queue_collapsed,
    backlog_rows: plan.backlog_rows,
  }));

  const result = await applyFlushPlan(sb, plan, 'alan-approve-flush');
  const out = {
    at: new Date().toISOString(),
    dry_run: false,
    write_count: plan.write_count,
    applied: result.applied,
    failed: result.failed,
    failures: result.results.filter((r) => !r.ok).map((r) => ({
      action: r.action,
      summary: r.summary,
      event_id: r.event_id,
      error: r.error,
      status: r.status,
    })),
    ok_sample: result.results.filter((r) => r.ok).slice(0, 10).map((r) => ({
      action: r.action,
      summary: r.summary,
      event_id: r.event_id,
    })),
  };
  fs.writeFileSync(path.join(root, 'tmp/gcal-flush-apply-LATEST.json'), JSON.stringify({
    ...out,
    results: result.results,
  }, null, 2));
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
