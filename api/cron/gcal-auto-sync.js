/**
 * Cron: Phase 3 auto-sync + client buffer attach + reconcile safety net.
 * - Re-attaches prep/decompress when Acuity moves a Zoom/online client
 *   (same parent event id, new times) — diary-drift alone is only 06:00 UTC.
 * - Flushes push queue when auto_sync_enabled + auto_sync_signed_off.
 * Auth: CRON_SECRET / MC_CRON_SECRET Bearer (same as diary-drift).
 */
const { json, sb, envReady } = require('../mc/_lib');
const {
  autoSyncIfAllowed, reconcileReport, dryRunSync,
} = require('../mc/gcal-auto-sync-lib');
const { fetchHorizonEvents, gcalConfigured } = require('../mc/gcal-lib');
const { runClientBufferReconcile } = require('../mc/client-buffer-reconcile-lib');
const { runWorkshopTravelReconcile } = require('../mc/workshop-travel-reconcile-lib');
const { runRuleEventMasterSync } = require('../mc/rule-event-masters-lib');
const { ruleMapFromRows } = require('../mc/scheduling-rules-lib');
const { londonToday, addDaysYmd } = require('../mc/diary-lib');
const { runScheduleSelfHeal } = require('../mc/schedule-self-heal-lib');
const { runTravelFollowLive } = require('../mc/travel-regenerate-apply-lib');

function authOk(req) {
  const secret = process.env.CRON_SECRET || process.env.MC_CRON_SECRET;
  if (!secret) return process.env.VERCEL_ENV !== 'production' && process.env.NODE_ENV !== 'production';
  const h = req.headers.authorization || '';
  return h === `Bearer ${secret}`;
}

async function runClientBufferPass() {
  if (!gcalConfigured()) {
    return { skipped: true, reason: 'gcal_not_configured' };
  }
  const today = londonToday();
  // 8 weeks matches Diary UI — catches near-term Acuity moves without full drift cost.
  const horizonEnd = addDaysYmd(today, 56);
  const rules = await sb('scheduling_rules?select=key,value') || [];
  const ruleMap = ruleMapFromRows(rules);
  const prepMin = Number(ruleMap.prep_buffer_min || 30);
  const decompMin = Number(ruleMap.decompress_buffer_min || 30);
  const { events } = await fetchHorizonEvents(
    `${today}T00:00:00Z`,
    `${horizonEnd}T23:59:59Z`,
  );
  const notes = [];
  const inserted = [];
  const existingPending = async () => true; // do not spam clash pendings on 15-min cron
  const stats = await runClientBufferReconcile({
    sb,
    notes,
    gcalEvents: events || [],
    prepMin,
    decompMin,
    today,
    horizonEnd,
    existingPending,
    inserted,
    ruleMap,
  });
  const workshopTravel = await runWorkshopTravelReconcile({
    sb,
    notes,
    gcalEvents: events || [],
    today,
    horizonEnd,
  });
  if (workshopTravel.deleted > 0) {
    try {
      await runRuleEventMasterSync(sb, { writeGcal: true, weeks: 12 });
      notes.push('workshop_travel_orphan: re-synced AWAY/REST masters');
    } catch (e) {
      notes.push(`workshop_travel_orphan_away_sync_error: ${e.message}`);
    }
  }
  // Near-term: move travel/AWAY to live workshop times (same pattern as client buffers).
  let travel_follow = null;
  try {
    // Near horizon every 15m; diary-drift (06:00) covers full 52w residentials.
    travel_follow = await runTravelFollowLive({
      sb,
      actor: 'cron-gcal-auto-sync',
      weeks: 12,
      apply: true,
      notes,
    });
  } catch (e) {
    travel_follow = { skipped: true, error: e.message };
    notes.push(`travel_follow_live_error: ${e.message}`);
  }
  return {
    skipped: false,
    from: today,
    to: horizonEnd,
    stats,
    workshop_travel: workshopTravel,
    travel_follow,
    notes: notes.slice(-16),
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return json(res, 405, { error: 'method not allowed' });
  }
  if (!authOk(req)) return json(res, 401, { error: 'unauthorized' });
  if (req.query?.probe === '1' || req.query?.probe === 'true') {
    return json(res, 200, { ok: true, probe: true, route: 'gcal-auto-sync' });
  }
  if (!envReady()) return json(res, 503, { error: 'MC_SUPABASE_NOT_CONFIGURED' });

  try {
    let client_buffers = null;
    try {
      client_buffers = await runClientBufferPass();
    } catch (e) {
      client_buffers = { skipped: true, error: e.message || 'client_buffer_pass_failed' };
    }

    const reconcile = await reconcileReport(sb);
    const auto = await autoSyncIfAllowed(sb, 'cron-gcal-auto-sync');
    const dry = (!auto.skipped && auto.mode === 'auto')
      ? null
      : await dryRunSync(sb);

    // Every 15 min: fixtures follow the feed, flanks repaint, orphans purge — no manual step.
    let self_heal = null;
    if (gcalConfigured()) {
      const healNotes = [];
      try {
        const r = await runScheduleSelfHeal(sb, { notes: healNotes, purgeLimit: 40 });
        self_heal = { notes: healNotes, purge_failed: r.purge?.failed?.length || 0 };
      } catch (e) {
        self_heal = { skipped: true, error: e.message || 'self_heal_failed', notes: healNotes };
      }
    }

    return json(res, 200, {
      ok: true,
      ran_at: new Date().toISOString(),
      client_buffers,
      reconcile,
      auto,
      self_heal,
      pending_dry_if_blocked: dry?.flush || null,
    });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message || 'gcal-auto-sync cron failed' });
  }
};
