/**
 * Phase 3 auto-sync orchestration (DB → Google via Cursor writer).
 * Kill switch: scheduling_rules.auto_sync_enabled
 * Gate: scheduling_rules.auto_sync_signed_off (Alan must approve dry-run first)
 * Manual Push always allowed when GCal is configured (ignores kill switch).
 */
const { ruleMapFromRows } = require('./scheduling-rules-lib');
const { buildFlushPlan, applyFlushPlan } = require('./gcal-flush-lib');
const { gcalConfigured } = require('./gcal-lib');
const { runRuleEventMasterSync } = require('./rule-event-masters-lib');
const {
  defaultHorizon, loadDbMasters, snapshotPrimaryMc,
} = require('./gcal-rebuild-lib');

function flagsFromRules(ruleMap) {
  return {
    auto_sync_enabled: String(ruleMap.auto_sync_enabled || 'false') === 'true',
    auto_sync_signed_off: String(ruleMap.auto_sync_signed_off || 'false') === 'true',
    cursor_writes_available: gcalConfigured(),
  };
}

async function loadFlags(sb) {
  const rules = await sb('scheduling_rules?select=key,value');
  return flagsFromRules(ruleMapFromRows(rules || []));
}

function summarisePlan(plan) {
  return {
    write_count: plan.write_count || 0,
    skipped_count: plan.skipped_count || 0,
    queue_raw: plan.queue_raw || 0,
    queue_collapsed: plan.queue_collapsed || 0,
    backlog_rows: plan.backlog_rows || 0,
    writes: (plan.writes || []).map((w) => ({
      action: w.action,
      entity_type: w.entity_type,
      event_id: w.event_id || null,
      summary: w.summary || null,
      from: w.from || null,
      to: w.to || null,
      source: w.source,
      source_id: w.source_id,
    })),
    skipped: plan.skipped || [],
  };
}

async function dryRunSync(sb) {
  const flags = await loadFlags(sb);
  const plan = await buildFlushPlan(sb);
  return {
    mode: 'dry_run',
    flags,
    note: flags.auto_sync_signed_off
      ? 'Signed off — auto-sync may write when auto_sync_enabled=true'
      : 'NOT signed off — auto-sync will not write until Alan approves this dry-run',
    flush: summarisePlan(plan),
  };
}

async function pushSync(sb, actor, { includeRuleMasters = true } = {}) {
  const flags = await loadFlags(sb);
  if (!flags.cursor_writes_available) {
    const err = new Error('GCAL_NOT_CONFIGURED');
    err.status = 503;
    throw err;
  }
  const plan = await buildFlushPlan(sb);
  const flush = await applyFlushPlan(sb, plan, actor || 'cursor-push');
  let rule_masters = null;
  if (includeRuleMasters) {
    try {
      rule_masters = await runRuleEventMasterSync(sb, { writeGcal: true, weeks: 52 });
    } catch (e) {
      rule_masters = { error: e.message };
    }
  }
  return {
    mode: 'manual_push',
    flags,
    flush: {
      planned: plan.write_count,
      applied: flush.applied,
      failed: flush.failed,
      results: flush.results,
    },
    rule_masters: rule_masters
      ? {
        rest: rule_masters.rest,
        away: rule_masters.away,
        fixtures: rule_masters.fixtures,
      }
      : null,
  };
}

/** Unattended auto-sync — only when kill switch on AND Alan signed off dry-run. */
async function autoSyncIfAllowed(sb, actor) {
  const flags = await loadFlags(sb);
  if (!flags.cursor_writes_available) {
    return { mode: 'auto', skipped: true, reason: 'gcal_not_configured', flags };
  }
  if (!flags.auto_sync_enabled) {
    return { mode: 'auto', skipped: true, reason: 'auto_sync_disabled', flags };
  }
  if (!flags.auto_sync_signed_off) {
    return { mode: 'auto', skipped: true, reason: 'awaiting_dry_run_sign_off', flags };
  }
  const result = await pushSync(sb, actor || 'cursor-auto-sync', { includeRuleMasters: true });
  return { ...result, mode: 'auto', skipped: false };
}

async function reconcileReport(sb) {
  const flags = await loadFlags(sb);
  const hz = defaultHorizon();
  // Rebuild horizon is ~52w; poll uses shorter window for speed
  const from = hz.from;
  const to = hz.to;
  const { masters, ruleMap, referencedIds } = await loadDbMasters(sb, from, to);
  const snap = await snapshotPrimaryMc(hz.timeMin, hz.timeMax, referencedIds, ruleMap);
  const plan = await buildFlushPlan(sb);
  const byOld = new Map(masters.filter((m) => m.old_event_id).map((m) => [m.old_event_id, m]));
  const missing = masters.filter((m) => !m.old_event_id);
  const orphanManaged = (snap.to_delete || []).filter((r) => !byOld.has(r.id));
  return {
    mode: 'reconcile',
    flags,
    horizon: { from, to },
    masters: masters.length,
    masters_missing_event_id: missing.length,
    gcal_managed_candidates: (snap.to_delete || []).length,
    orphan_managed_not_in_db_ids: orphanManaged.length,
    pending_flush_writes: plan.write_count,
    pending_flush_sample: summarisePlan(plan).writes.slice(0, 25),
    left_uncertain: snap.left_uncertain?.length || 0,
  };
}

module.exports = {
  flagsFromRules,
  loadFlags,
  dryRunSync,
  pushSync,
  autoSyncIfAllowed,
  reconcileReport,
  summarisePlan,
};
