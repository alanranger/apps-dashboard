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
    live_db_times: !!plan.live_db_times,
    writes: (plan.writes || []).map((w) => ({
      action: w.action,
      entity_type: w.entity_type,
      event_id: w.event_id || null,
      summary: w.summary || null,
      from: w.from || null,
      to: w.to || null,
      live_from: w.live_from || null,
      display_id: w.display_id || null,
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

async function acquirePushLock(sb) {
  const key = 'gcal_push_inflight_until';
  const now = Date.now();
  const rows = await sb(`scheduling_rules?key=eq.${encodeURIComponent(key)}&select=key,value`);
  const cur = rows?.[0];
  const until = Number(cur?.value || 0);
  if (until > now) {
    const err = new Error('PUSH_ALREADY_IN_PROGRESS — wait for the current Push to finish');
    err.status = 409;
    throw err;
  }
  const body = {
    key,
    value: String(now + 4 * 60 * 1000),
    value_type: 'string',
    description: 'Epoch ms — Push lock expires; prevents duplicate REST/AWAY creates',
    updated_at: new Date().toISOString(),
  };
  if (cur) {
    await sb(`scheduling_rules?key=eq.${encodeURIComponent(key)}`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: { value: body.value, updated_at: body.updated_at },
    });
  } else {
    await sb('scheduling_rules', { method: 'POST', prefer: 'return=minimal', body });
  }
}

async function releasePushLock(sb) {
  const key = 'gcal_push_inflight_until';
  try {
    await sb(`scheduling_rules?key=eq.${encodeURIComponent(key)}`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: { value: '0', updated_at: new Date().toISOString() },
    });
  } catch (_) { /* ignore */ }
}

async function pushSync(sb, actor, {
  includeRuleMasters = true,
  includeBacklog = false,
} = {}) {
  const flags = await loadFlags(sb);
  if (!flags.cursor_writes_available) {
    const err = new Error('GCAL_NOT_CONFIGURED');
    err.status = 503;
    throw err;
  }
  await acquirePushLock(sb);
  try {
    // Diary Push = gcal_push_queue only. Habit-placement backlog is separate (too big for one request).
    const plan = await buildFlushPlan(sb, { includeBacklog: !!includeBacklog });
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
        include_backlog: !!includeBacklog,
        backlog_rows: plan.backlog_rows || 0,
      },
      rule_masters: rule_masters
        ? {
          rest: rule_masters.rest,
          away: rule_masters.away,
          fixtures: rule_masters.fixtures,
          gaps: rule_masters.gaps,
        }
        : null,
    };
  } finally {
    await releasePushLock(sb);
  }
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
  const from = hz.from;
  const to = hz.to;
  const { masters, ruleMap, referencedIds } = await loadDbMasters(sb, from, to);
  const snap = await snapshotPrimaryMc(hz.timeMin, hz.timeMax, referencedIds, ruleMap);
  const plan = await buildFlushPlan(sb, { includeBacklog: false });
  const { getPrimaryEvent } = require('./gcal-write-lib');

  const mismatches = [];
  const checked = [];
  for (const m of masters || []) {
    if (!m.start || !m.end) continue;
    // Placed in DB but no Google event id → mismatch (was a false ✓ blind-spot).
    if (!m.old_event_id) {
      const row = {
        kind: m.kind,
        title: m.title,
        db_start: m.start,
        db_end: m.end,
        event_id: null,
        reason: 'placed_missing_calendar_event_id',
        titleOk: false,
        startOk: false,
        endOk: false,
      };
      checked.push(row);
      mismatches.push(row);
      continue;
    }
    try {
      const live = await getPrimaryEvent(m.old_event_id);
      const liveStart = live?.start?.dateTime || live?.start?.date || null;
      const liveEnd = live?.end?.dateTime || live?.end?.date || null;
      const titleOk = String(live?.summary || '') === String(m.title || '');
      const startOk = Math.abs(Date.parse(liveStart) - Date.parse(m.start)) <= 120000;
      const endOk = Math.abs(Date.parse(liveEnd) - Date.parse(m.end)) <= 120000;
      const row = {
        kind: m.kind,
        title: m.title,
        db_start: m.start,
        db_end: m.end,
        gcal_start: liveStart,
        gcal_end: liveEnd,
        event_id: m.old_event_id,
        titleOk,
        startOk,
        endOk,
      };
      checked.push(row);
      if (!titleOk || !startOk || !endOk) mismatches.push(row);
    } catch (e) {
      mismatches.push({
        kind: m.kind, title: m.title, event_id: m.old_event_id,
        error: e.message, db_start: m.start, db_end: m.end,
      });
    }
  }

  // Managed Google orphans are engine-deletable — report separately from mirror match.
  const managed_orphans = (snap.to_delete || []).map((u) => ({
    kind: 'google_orphan',
    title: u.summary,
    event_id: u.id,
    gcal_start: u.start,
    gcal_end: u.end,
    reason: 'unplaced_or_unlinked_still_on_google',
  }));

  // Liveable diary = LIVE Google commitments (not mirror-only).
  const { fetchHorizonEvents } = require('./gcal-lib');
  const { validateLiveableDiary } = require('./liveable-diary-lib');
  const [travelBlocks, restDb, liveGcal] = await Promise.all([
    sb(`travel_blocks?select=*&starts_at=gte.${hz.timeMin}&starts_at=lt.${hz.timeMax}&order=starts_at.asc`),
    sb('rest_day_blocks?status=eq.active&select=rest_date,workshop_title'),
    fetchHorizonEvents(hz.timeMin, hz.timeMax),
  ]);
  const liveable = validateLiveableDiary({
    events: liveGcal.events || [],
    travelBlocks: travelBlocks || [],
    ruleMap,
    restDb: restDb || [],
  });

  const mirrorOk = mismatches.length === 0;
  const liveableOk = !!liveable.ok;
  const match = mirrorOk && liveableOk;
  const statusLine = match
    ? 'Diary liveable: ✓ (mirror + live calendar)'
    : !liveableOk
      ? `Diary liveable: ✗ — ${liveable.violation_count} live violation(s)`
      : `Google matches DB: ✗ — ${mismatches.length} mismatch${mismatches.length === 1 ? '' : 'es'}`;
  const nowIso = new Date().toISOString();
  try {
    const existing = await sb(
      `scheduling_rules?key=eq.${encodeURIComponent('gcal_reconcile_status_line')}&select=key`,
    );
    const body = {
      key: 'gcal_reconcile_status_line',
      value: statusLine,
      value_type: 'string',
      description: 'Standing DB↔Google reconcile one-liner for Diary',
      updated_at: nowIso,
    };
    if (existing?.[0]) {
      await sb(`scheduling_rules?key=eq.${encodeURIComponent('gcal_reconcile_status_line')}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: { value: statusLine, updated_at: nowIso },
      });
    } else {
      await sb('scheduling_rules', { method: 'POST', prefer: 'return=minimal', body });
    }
    await sb(`scheduling_rules?key=eq.${encodeURIComponent('gcal_reconcile_at')}`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: { value: nowIso, updated_at: nowIso },
    }).catch(async () => {
      await sb('scheduling_rules', {
        method: 'POST', prefer: 'return=minimal',
        body: {
          key: 'gcal_reconcile_at',
          value: nowIso,
          value_type: 'string',
          description: 'Last reconcile timestamp',
          updated_at: nowIso,
        },
      });
    });
  } catch (_) { /* non-fatal */ }

  return {
    mode: 'reconcile',
    flags,
    horizon: { from, to },
    google_matches_db: mirrorOk,
    diary_liveable: liveableOk,
    liveable,
    status_line: statusLine,
    ok: match,
    checked_count: checked.length,
    mismatch_count: mismatches.length,
    mismatches: mismatches.slice(0, 50),
    managed_orphans_count: managed_orphans.length,
    managed_orphans_sample: managed_orphans.slice(0, 25),
    masters: masters.length,
    masters_missing_event_id: masters.filter((m) => !m.old_event_id).length,
    pending_flush_writes: plan.write_count,
    pending_flush_sample: summarisePlan(plan).writes.slice(0, 25),
    pending_flush_live_db_times: !!plan.live_db_times,
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
