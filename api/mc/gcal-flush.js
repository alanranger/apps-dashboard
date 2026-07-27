/**
 * POST /api/mc/gcal-flush
 * Phase 2 baseline sync. Default dry_run=true. apply=true writes Calendar.
 */
const {
  envReady, json, cors, readBody, requireAuth, actorFromSession, sb,
} = require('./_lib');
const { buildFlushPlan, applyFlushPlan } = require('./gcal-flush-lib');
const { testWriteRoundTrip } = require('./gcal-write-lib');
const { gcalConfigured } = require('./gcal-lib');

module.exports = async function handler(req, res) {
  if (cors(req, res)) return;
  if (!envReady()) return json(res, 503, { error: 'MC_SUPABASE_NOT_CONFIGURED' });
  const session = requireAuth(req, res);
  if (!session) return;

  try {
    if (req.method === 'GET') {
      const probe = req.query?.probe === '1' || req.url?.includes('probe=1');
      if (probe) {
        const result = await testWriteRoundTrip();
        return json(res, result.ok ? 200 : 403, { configured: gcalConfigured(), ...result });
      }
      const plan = await buildFlushPlan(sb);
      return json(res, 200, plan);
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const actor = actorFromSession(session, body);
      const plan = await buildFlushPlan(sb);
      const apply = body.apply === true || body.dry_run === false;
      if (!apply) {
        return json(res, 200, { ...plan, dry_run: true, note: 'Pass apply:true to write' });
      }
      const result = await applyFlushPlan(sb, plan, actor);
      return json(res, 200, {
        dry_run: false,
        write_count: plan.write_count,
        ...result,
      });
    }

    return json(res, 405, { error: 'method not allowed' });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message || 'gcal-flush error', detail: e.data });
  }
};
