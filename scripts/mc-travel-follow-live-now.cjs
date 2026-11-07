/**
 * One-shot: orphan prune + move/create travel from live GCal + AWAY/REST sync.
 * Usage: node scripts/mc-travel-follow-live-now.cjs [--dry]
 */
const fs = require('fs');
const path = require('path');

function loadEnv() {
  const p = path.join(__dirname, '..', '.env.local');
  if (!fs.existsSync(p)) throw new Error('missing .env.local');
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m || process.env[m[1]]) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

async function main() {
  loadEnv();
  const dry = process.argv.includes('--dry');
  const { sb } = require('../api/mc/_lib');
  const { runTravelFollowLive } = require('../api/mc/travel-regenerate-apply-lib');
  const notes = [];
  const result = await runTravelFollowLive({
    sb,
    actor: 'cursor-travel-follow-live',
    weeks: 52,
    apply: !dry,
    notes,
  });
  const would = result.would_apply || [];
  const hartland = [...(result.applied || []), ...would]
    .filter((a) => /hartland/i.test(a.title || ''));
  const createdH = (result.created || []).filter((a) => /hartland/i.test(a.title || ''));
  const bluebell = would.filter((a) => /bluebell/i.test(a.title || ''));
  console.log(JSON.stringify({
    dry,
    orphan_deleted: result.orphan?.deleted || 0,
    applied_count: (result.applied || []).length,
    created_count: (result.created || []).length,
    times_changed_count: result.times_changed_count,
    would_apply: would,
    hartland,
    bluebell_moves: bluebell,
    hartland_created: createdH,
    unmatched_sample: (result.plan?.unmatched || []).slice(0, 10),
    notes: notes.slice(-20),
  }, null, 2));
  process.exit(0);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
