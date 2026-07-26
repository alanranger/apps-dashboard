/**
 * GET/PATCH /api/mc/gcal-push — consolidated push manifest for Claude flush.
 * Push button marks ready; does NOT write Google Calendar.
 */
const {
  envReady, json, cors, readBody, requireAuth, actorFromSession, sb,
} = require('./_lib');
const { ruleMapFromRows } = require('./scheduling-rules-lib');
const {
  listOpenPush, listAwaySpanBacklog, markPushStatus, markAllPendingReady, BACKLOG_SQL_HINT,
  collapsePushManifest,
} = require('./gcal-push-lib');

module.exports = async function handler(req, res) {
  if (cors(req, res)) return;
  if (!envReady()) return json(res, 503, { error: 'MC_SUPABASE_NOT_CONFIGURED' });
  const session = requireAuth(req, res);
  if (!session) return;

  try {
    const rules = await sb('scheduling_rules?select=key,value');
    const ruleMap = ruleMapFromRows(rules);
    const writesAvailable = String(ruleMap.gcal_writes_available || 'false') === 'true';

    if (req.method === 'GET') {
      const [open, backlog] = await Promise.all([listOpenPush(sb), listAwaySpanBacklog(sb)]);
      const collapsed = collapsePushManifest(open || []);
      return json(res, 200, {
        writes_available: writesAvailable,
        push_button_enabled: writesAvailable,
        items: collapsed,
        items_raw_count: (open || []).length,
        items_collapsed_count: collapsed.length,
        backlog: backlog || [],
        backlog_filter: BACKLOG_SQL_HINT,
        how_to_flush: [
          '1. Alan clicks Push when writes_available=true (marks items status=ready).',
          '2. Claude reads items (already occurrence-collapsed: complete/skip beats move/pin for same habit+event/ideal).',
          '3. Claude ALSO applies backlog rows (pending_diary_changes away-span set).',
          '4. Claude performs GCal writes; one net action per occurrence.',
          '5. Claude PATCH /api/mc/gcal-push { action: applied, ids: [...] } and Scheduling pending applied for backlog.',
          '6. Diary complete/skip also dismisses sibling open queue rows for the same habit occurrence.',
        ],
        calendar_writes: 0,
      });
    }

    if (req.method === 'PATCH') {
      const body = await readBody(req);
      const actor = actorFromSession(session, body);

      if (body.action === 'mark_ready') {
        if (!writesAvailable) {
          return json(res, 409, {
            error: 'gcal_writes_available=false — Push disabled until Anthropic GCal writes recover',
            writes_available: false,
            calendar_writes: 0,
          });
        }
        const updated = body.ids?.length
          ? await markPushStatus(sb, body.ids, 'ready', actor)
          : await markAllPendingReady(sb, actor);
        return json(res, 200, {
          marked_ready: updated.length,
          items: updated,
          backlog_still_pending: (await listAwaySpanBacklog(sb)).length,
          note: 'Claude should now flush ready items + away-span backlog',
          calendar_writes: 0,
        });
      }

      if (body.action === 'applied' || body.action === 'dismissed') {
        if (!body.ids?.length) return json(res, 400, { error: 'ids required' });
        const updated = await markPushStatus(sb, body.ids, body.action, actor);
        return json(res, 200, { updated: updated.length, items: updated, calendar_writes: 0 });
      }

      return json(res, 400, { error: 'action required: mark_ready|applied|dismissed' });
    }

    return json(res, 405, { error: 'method not allowed' });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message || 'gcal-push error', detail: e.data });
  }
};
