/**
 * Publish rules-based schedule backlog to Google in small batches (local — avoids Vercel timeout).
 *
 * Includes: gcal_push_queue + pending habit_placement / task_bump (listAwaySpanBacklog).
 * Does NOT auto-resolve rule_breach decision rows.
 *
 * Usage:
 *   node scripts/mc-publish-rules-backlog.cjs --dry-run
 *   node scripts/mc-publish-rules-backlog.cjs --apply [--batch=12] [--max-batches=40]
 */
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env.local');
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { sb } = require('../api/mc/_lib');
const { buildFlushPlan, applyFlushPlan } = require('../api/mc/gcal-flush-lib');
const { gcalConfigured } = require('../api/mc/gcal-lib');

function arg(name, def) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  return def;
}

async function counts() {
  const pending = await sb('pending_diary_changes?status=eq.pending&select=change_type');
  const by = {};
  for (const r of pending || []) {
    by[r.change_type] = (by[r.change_type] || 0) + 1;
  }
  const queue = await sb('gcal_push_queue?status=in.(pending,ready)&select=id');
  return { pending_by_type: by, push_queue: (queue || []).length };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const dryRun = process.argv.includes('--dry-run') || !apply;
  const batchSize = Math.max(1, Number(arg('batch', '12')) || 12);
  const maxBatches = Math.max(1, Number(arg('max-batches', '40')) || 40);

  if (!gcalConfigured()) {
    console.error('GCAL not configured in .env.local');
    process.exit(1);
  }

  console.log(dryRun ? 'DRY RUN — no Google writes' : 'APPLY — writing Google in batches');
  console.log('Before:', JSON.stringify(await counts(), null, 2));

  let totalApplied = 0;
  let totalFailed = 0;
  let batch = 0;

  while (batch < maxBatches) {
    batch += 1;
    const full = await buildFlushPlan(sb, { includeBacklog: true });
    const writes = full.writes || [];
    console.log(`\nBatch ${batch}: plan writes=${writes.length} skipped=${full.skipped_count} backlog_rows=${full.backlog_rows}`);

    if (!writes.length) {
      console.log('Nothing left to flush.');
      break;
    }

    const chunk = writes.slice(0, batchSize);
    console.log(`  Applying ${chunk.length} of ${writes.length}:`);
    for (const w of chunk) {
      console.log(`   - ${w.action} ${w.entity_type || ''} ${w.summary || w.event_id || w.source_id || ''}`);
    }

    if (dryRun) {
      console.log('Dry-run stop after first batch preview.');
      break;
    }

    const result = await applyFlushPlan(sb, { writes: chunk }, 'rules-backlog-publish');
    totalApplied += result.applied || 0;
    totalFailed += result.failed || 0;
    console.log(`  → applied=${result.applied} failed=${result.failed}`);
    for (const r of (result.results || []).filter((x) => !x.ok)) {
      console.log(`    FAIL: ${r.summary || r.event_id || r.source_id} — ${r.error}`);
    }

    if ((result.applied || 0) === 0 && (result.failed || 0) > 0) {
      console.error('Batch made no progress — stopping to avoid loop.');
      break;
    }
  }

  console.log('\nAfter:', JSON.stringify(await counts(), null, 2));
  console.log(`Totals: applied=${totalApplied} failed=${totalFailed}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
