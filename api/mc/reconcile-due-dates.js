/**
 * MC calendar→DB reconcile (APPLY side only — NO Google Calendar access here).
 *
 * Claude reads Google Calendar separately, matches MC-nn IDs, diffs vs DB, and
 * POSTs the resulting changes to this endpoint. The app never touches the
 * calendar. Only `due_date` (+ `last_activity_at`) is ever written to `tasks`.
 *
 * Body: { "changes": [ { "display_id": 15, "new_due_date": "2026-08-10",
 *          "source": "google-calendar", "calendar_event_id": "..." }, ... ] }
 * Returns: { updated: [...], unchanged: [...], unmatched: [...] }
 *
 * Every change is written to mc_reconcile_log (updated / no_change / unmatched).
 */
const { envReady, json, cors, readBody, requireAuth, sb } = require('./_lib');

function isYmd(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

async function logRow(entry) {
  try {
    await sb('mc_reconcile_log', { method: 'POST', prefer: 'return=minimal', body: entry });
  } catch (e) {
    // audit log write is best-effort; never fail the reconcile because of it
  }
}

/** Decide the outcome for one change without mutating anything. */
function classify(change, byId) {
  const did = Number(change.display_id);
  const nd = change.new_due_date;
  const idOk = Number.isInteger(did);
  const base = {
    display_id: idOk ? did : null,
    source: change.source || null,
    calendar_event_id: change.calendar_event_id || null,
  };
  if (!idOk || !isYmd(nd)) return { result: 'unmatched', old: null, nd: isYmd(nd) ? nd : null, task: null, base };
  const task = byId.get(did);
  if (!task) return { result: 'unmatched', old: null, nd, task: null, base };
  const old = task.due_date || null;
  if (old === nd) return { result: 'no_change', old, nd, task, base };
  return { result: 'updated', old, nd, task, base };
}

module.exports = async function handler(req, res) {
  if (cors(req, res)) return;
  if (!envReady()) return json(res, 503, { error: 'MC_SUPABASE_NOT_CONFIGURED' });
  const session = requireAuth(req, res);
  if (!session) return;
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
  try {
    const body = await readBody(req);
    const changes = Array.isArray(body?.changes) ? body.changes : [];

    const ids = [...new Set(changes.map((c) => Number(c.display_id)).filter(Number.isInteger))];
    const byId = new Map();
    if (ids.length) {
      const rows = await sb(`tasks?display_id=in.(${ids.join(',')})&select=id,display_id,due_date`);
      for (const r of rows || []) byId.set(Number(r.display_id), r);
    }

    const updated = [];
    const unchanged = [];
    const unmatched = [];
    for (const c of changes) {
      const d = classify(c, byId);
      if (d.result === 'updated') {
        await sb(`tasks?id=eq.${d.task.id}`, {
          method: 'PATCH',
          prefer: 'return=minimal',
          body: { due_date: d.nd, last_activity_at: new Date().toISOString() },
        });
        updated.push({ display_id: d.base.display_id, old_due_date: d.old, new_due_date: d.nd });
      } else if (d.result === 'no_change') {
        unchanged.push({ display_id: d.base.display_id, due_date: d.nd });
      } else {
        unmatched.push({ display_id: c.display_id, new_due_date: d.nd });
      }
      await logRow({
        display_id: d.base.display_id,
        old_due_date: d.old,
        new_due_date: d.nd,
        result: d.result,
        source: d.base.source,
        calendar_event_id: d.base.calendar_event_id,
      });
    }

    return json(res, 200, { updated, unchanged, unmatched });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message || 'reconcile error', detail: e.data });
  }
};
