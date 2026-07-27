/**
 * Cron: Phase 3 auto-sync + reconcile safety net.
 * - Always runs reconcile report (no writes).
 * - Flushes only when auto_sync_enabled + auto_sync_signed_off.
 * Auth: CRON_SECRET / MC_CRON_SECRET Bearer (same as diary-drift).
 */
const { json, sb, envReady } = require('../mc/_lib');
const {
  autoSyncIfAllowed, reconcileReport, dryRunSync,
} = require('../mc/gcal-auto-sync-lib');

function authOk(req) {
  const secret = process.env.CRON_SECRET || process.env.MC_CRON_SECRET;
  if (!secret) return true;
  const h = req.headers.authorization || '';
  return h === `Bearer ${secret}`;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return json(res, 405, { error: 'method not allowed' });
  }
  if (!authOk(req)) return json(res, 401, { error: 'unauthorized' });
  if (!envReady()) return json(res, 503, { error: 'MC_SUPABASE_NOT_CONFIGURED' });

  try {
    const reconcile = await reconcileReport(sb);
    const auto = await autoSyncIfAllowed(sb, 'cron-gcal-auto-sync');
    const dry = (!auto.skipped && auto.mode === 'auto')
      ? null
      : await dryRunSync(sb);

    return json(res, 200, {
      ok: true,
      ran_at: new Date().toISOString(),
      reconcile,
      auto,
      pending_dry_if_blocked: dry?.flush || null,
    });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message || 'gcal-auto-sync cron failed' });
  }
};
