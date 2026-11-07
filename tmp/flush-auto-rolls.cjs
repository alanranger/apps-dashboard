const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

const { sb } = require('../api/mc/_lib.js');
const { buildFlushPlan, applyFlushPlan } = require('../api/mc/gcal-flush-lib.js');

(async () => {
  const plan = await buildFlushPlan(sb);
  const writes = plan.writes || plan.items || [];
  console.log('write_count', plan.write_count ?? writes.length);
  const rolls = writes.filter((w) => /Auto-roll/i.test(String(w.summary || '')));
  console.log('auto-roll rows', rolls.length);
  for (const w of rolls) {
    console.log('-', w.summary || w.related_id, w.payload?.new_start || '');
  }
  if (process.argv.includes('--apply')) {
    const result = await applyFlushPlan(sb, plan, 'cursor');
    console.log(JSON.stringify({
      applied: result.applied,
      failed: result.failed,
      write_count: plan.write_count,
      errors: (result.errors || []).slice(0, 5),
    }, null, 2));
  } else {
    console.log('dry run only — pass --apply to write Calendar');
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
