/**
 * POST /api/mc/rule-breach-check — Claude supplies MC block list; app proposes fixes only.
 */
const { envReady, json, cors, readBody, requireAuth, sb } = require('./_lib');
const { ruleMapFromRows } = require('./scheduling-rules-lib');
const { buildRuleBreachProposals } = require('./rule-breach-lib');

module.exports = async function handler(req, res) {
  if (cors(req, res)) return;
  if (!envReady()) return json(res, 503, { error: 'MC_SUPABASE_NOT_CONFIGURED' });
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
  const session = requireAuth(req, res);
  if (!session) return;
  try {
    const body = await readBody(req);
    const blocks = Array.isArray(body?.blocks) ? body.blocks : [];
    const rules = await sb('scheduling_rules?select=key,value');
    const ruleMap = ruleMapFromRows(rules);
    const pinnedIds = new Set();
    const taskRows = await sb('tasks?select=display_id&slot_pinned=eq.true');
    for (const t of taskRows || []) pinnedIds.add(Number(t.display_id));
    const proposals = buildRuleBreachProposals(blocks, ruleMap, pinnedIds);
    return json(res, 200, { proposals, calendar_writes: 0 });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message || 'rule-breach-check error', detail: e.data });
  }
};
