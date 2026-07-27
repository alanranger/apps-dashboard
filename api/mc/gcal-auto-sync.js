/**
 * GET/POST /api/mc/gcal-auto-sync — Phase 3 Cursor→Google sync control plane.
 *
 * GET  → status + dry-run plan (never writes)
 * POST actions:
 *   dry_run     — plan only
 *   push        — manual flush (works even when auto_sync_enabled=false)
 *   reconcile   — DB vs Google report (no writes)
 *   auto        — unattended sync (requires enabled + signed_off)
 *   set_flags   — { auto_sync_enabled?, auto_sync_signed_off? } (Alan/Cursor)
 */
const {
  envReady, json, cors, readBody, requireAuth, actorFromSession, sb,
} = require('./_lib');
const {
  loadFlags, dryRunSync, pushSync, autoSyncIfAllowed, reconcileReport,
} = require('./gcal-auto-sync-lib');

async function upsertRule(key, value, actor) {
  const cur = (await sb(`scheduling_rules?key=eq.${encodeURIComponent(key)}`))?.[0];
  if (cur) {
    await sb(`scheduling_rules?key=eq.${encodeURIComponent(key)}`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: { value: String(value), updated_at: new Date().toISOString() },
    });
  } else {
    await sb('scheduling_rules', {
      method: 'POST', prefer: 'return=minimal',
      body: { key, value: String(value), value_type: 'bool', description: 'Phase 3 auto-sync flag' },
    });
  }
    await sb('scheduling_rules_audit', {
      method: 'POST',
      body: {
        key, old_value: cur?.value ?? null, new_value: String(value), changed_by: actor || 'cursor',
      },
    });
}

module.exports = async function handler(req, res) {
  if (cors(req, res)) return;
  if (!envReady()) return json(res, 503, { error: 'MC_SUPABASE_NOT_CONFIGURED' });
  const session = requireAuth(req, res);
  if (!session) return;

  try {
    if (req.method === 'GET') {
      const dry = await dryRunSync(sb);
      return json(res, 200, dry);
    }

    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });

    const body = await readBody(req);
    const actor = actorFromSession(session, body);
    const action = String(body.action || 'dry_run');

    if (action === 'dry_run') {
      return json(res, 200, await dryRunSync(sb));
    }
    if (action === 'push') {
      return json(res, 200, await pushSync(sb, actor, {
        includeRuleMasters: body.include_rule_masters !== false,
      }));
    }
    if (action === 'reconcile') {
      return json(res, 200, await reconcileReport(sb));
    }
    if (action === 'auto') {
      return json(res, 200, await autoSyncIfAllowed(sb, actor));
    }
    if (action === 'set_flags') {
      if (body.auto_sync_enabled != null) {
        await upsertRule('auto_sync_enabled', body.auto_sync_enabled === true || body.auto_sync_enabled === 'true', actor);
      }
      if (body.auto_sync_signed_off != null) {
        await upsertRule('auto_sync_signed_off', body.auto_sync_signed_off === true || body.auto_sync_signed_off === 'true', actor);
      }
      return json(res, 200, { ok: true, flags: await loadFlags(sb) });
    }

    return json(res, 400, {
      error: 'action required: dry_run|push|reconcile|auto|set_flags',
    });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message || 'gcal-auto-sync error', detail: e.data });
  }
};
