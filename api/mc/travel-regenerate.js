/**
 * POST /api/mc/travel-regenerate — recompute travel_blocks from live GCal workshops.
 * dry_run (default) or apply=true. DB + gcal_push_queue only; never writes Calendar.
 */
const {
  envReady, json, cors, readBody, requireAuth, actorFromSession, sb,
} = require('./_lib');
const { gcalConfigured } = require('./gcal-lib');
const { runTravelFollowLive } = require('./travel-regenerate-apply-lib');

module.exports = async function handler(req, res) {
  if (cors(req, res)) return;
  if (!envReady()) return json(res, 503, { error: 'MC_SUPABASE_NOT_CONFIGURED' });
  const session = requireAuth(req, res);
  if (!session) return;

  if (req.method === 'GET') {
    return json(res, 200, {
      ok: true,
      usage: {
        POST: {
          dry_run: 'default true — report only',
          apply: 'true to PATCH travel_blocks + queue GCal moves',
          weeks: 'optional horizon weeks (default 52)',
        },
      },
    });
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });

  try {
    if (!gcalConfigured()) {
      return json(res, 503, { error: 'GCAL_NOT_CONFIGURED' });
    }
    const body = await readBody(req);
    const actor = actorFromSession(session, body);
    const apply = body.apply === true || body.dry_run === false;
    const weeks = Math.min(104, Math.max(4, Number(body.weeks) || 52));
    const notes = [];
    const result = await runTravelFollowLive({
      sb, actor, weeks, apply, notes,
    });
    const plan = result.plan || {};
    return json(res, 200, {
      ok: true,
      dry_run: !apply,
      applied_count: (result.applied || []).length,
      applied: result.applied || [],
      linked_count: (plan.linked || []).length,
      calendar_writes: 0,
      notes,
      ...plan,
    });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message || 'travel-regenerate failed', detail: e.data });
  }
};
