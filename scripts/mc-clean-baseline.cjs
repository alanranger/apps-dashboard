/**
 * Clean Google + MC baseline:
 * 1) Re-sync rule masters (prunes bad decompress / away)
 * 2) Dismiss pending noise so Alan only sees real decisions
 *
 * node scripts/mc-clean-baseline.cjs [--dry-run]
 */
const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '..', '.env.local');
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { sb } = require('../api/mc/_lib');
const { runRuleEventMasterSync } = require('../api/mc/rule-event-masters-lib');
const { isoToLondonDate } = require('../api/mc/scheduling-rules-lib');

const DRY = process.argv.includes('--dry-run');
const TODAY = isoToLondonDate(new Date().toISOString()) || '2026-07-27';

async function dismiss(id, note) {
  if (DRY) return;
  await sb(`pending_diary_changes?id=eq.${id}`, {
    method: 'PATCH', prefer: 'return=minimal',
    body: {
      status: 'dismissed',
      resolved_at: new Date().toISOString(),
      resolved_by: 'cursor',
      reason: note || undefined,
    },
  });
}

function isPast(d) {
  return d && String(d) < TODAY;
}

function isNoise(row) {
  const s = String(row.summary || '');
  const r = String(row.reason || '');
  const t = row.change_type;

  if (t === 'missed_habit' && isPast(row.target_date)) {
    return 'past missed habit — skip for clean baseline';
  }
  if (t === 'diary_manual_move' && isPast(row.target_date)) {
    return 'past diary move noise';
  }
  if (t === 'rule_breach') {
    if (/all-day|hotel\/reminder|⏰|lands on busy/i.test(s)) {
      return 'all-day reminder — not a diary clash';
    }
    // Gap MOVE proposals = alternate scenarios. Baseline = live Google.
    if (/gap -?\d+m < \d+m decompress/i.test(s) || /decompress_gap_need=/i.test(r)) {
      return 'baseline: gap proposal dismissed — live calendar is source of truth';
    }
    if (/within 30m tolerance — not a breach/i.test(s)) {
      return 'soft over-target — within tolerance';
    }
    if (/before \d+:\d+ window|after \d+:\d+ window|bank holiday/i.test(s)
      && /Travel|🚗|Workshop|Photography Workshop/i.test(s)) {
      return 'travel/workshop outside window by design';
    }
  }
  if (t === 'cap_over_target' && /within 30m tolerance/i.test(s + r)) {
    return 'soft cap within tolerance';
  }
  return null;
}

async function main() {
  console.log(DRY ? 'DRY RUN' : 'APPLY', 'today=', TODAY);

  console.log('\n== Re-sync rule masters (decompress prune/fix) ==');
  const sync = await runRuleEventMasterSync(sb, { writeGcal: !DRY, weeks: 52 });
  console.log(JSON.stringify({
    gaps: {
      adequate: sync.gaps?.adequate_pairs,
      created: sync.gaps?.created,
      updated: sync.gaps?.updated,
      pruned: sync.gaps?.pruned,
      tight: sync.gaps?.tight_pairs,
      failed: (sync.gaps?.failed || []).length,
    },
    away: { desired: sync.away?.desired, created: sync.away?.created, updated: sync.away?.updated },
    rest: { desired: sync.rest?.desired, created: sync.rest?.created, updated: sync.rest?.updated },
  }, null, 2));

  const pending = await sb(
    'pending_diary_changes?status=eq.pending&select=id,change_type,summary,reason,target_date,proposed_action',
  ) || [];

  console.log('\n== Dismiss pending noise ==');
  let n = 0;
  for (const row of pending) {
    const why = isNoise(row);
    if (!why) continue;
    console.log(`  dismiss [${row.change_type}] ${(row.summary || '').slice(0, 70)} — ${why}`);
    await dismiss(row.id, why);
    n += 1;
  }
  console.log(`Dismissed ${n}`);

  const after = await sb('pending_diary_changes?status=eq.pending&select=change_type') || [];
  const by = {};
  for (const r of after) by[r.change_type] = (by[r.change_type] || 0) + 1;
  console.log('\nPending left (real decisions):', by);

  const gaps = await sb(
    "gap_buffer_blocks?status=eq.active&day=gte.2026-07-27&day=lte.2026-08-16&select=day,after_label,before_label,starts_at",
  ) || [];
  console.log('\nActive decompress 27 Jul–16 Aug:');
  for (const g of gaps.sort((a, b) => String(a.day).localeCompare(b.day) || String(a.starts_at).localeCompare(b.starts_at))) {
    console.log(`  ${g.day} after "${String(g.after_label).slice(0, 45)}" → before "${String(g.before_label).slice(0, 35)}"`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
