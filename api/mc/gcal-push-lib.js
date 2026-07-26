/**
 * Consolidated GCal push queue — one related_id, latest state wins.
 * No Google Calendar writes from this module.
 */
const BACKLOG_SQL_HINT = [
  "status='pending' AND (",
  "change_type='habit_placement'",
  "OR related_id LIKE 'task_bump:MC-%'",
  "OR related_id LIKE 'task_bump:audit:%'",
  "OR related_id='travel_back_fix:rosedale:2026-08-06'",
  ')',
].join(' ');

function relatedIdForTask(taskId) {
  return `gcal:task:${taskId}`;
}

function relatedIdForHabit(habitId, idealDate) {
  return `gcal:habit:${habitId}:${idealDate}`;
}

async function upsertPushRow(sb, row) {
  const existing = await sb(
    `gcal_push_queue?related_id=eq.${encodeURIComponent(row.related_id)}&select=id,status`,
  );
  const prev = existing?.[0];
  const body = {
    related_id: row.related_id,
    entity_type: row.entity_type,
    change_kind: row.change_kind,
    summary: row.summary,
    proposed_action: row.proposed_action,
    payload: row.payload || {},
    updated_at: new Date().toISOString(),
    status: prev?.status === 'ready' ? 'ready' : 'pending',
    resolved_at: null,
    resolved_by: null,
  };
  if (prev) {
    await sb(`gcal_push_queue?id=eq.${prev.id}`, {
      method: 'PATCH', prefer: 'return=minimal', body,
    });
    return { id: prev.id, collapsed: true };
  }
  const inserted = await sb('gcal_push_queue', {
    method: 'POST', prefer: 'return=representation', body,
  });
  return { id: inserted?.[0]?.id || null, collapsed: false };
}

async function listOpenPush(sb) {
  return sb(
    'gcal_push_queue?status=in.(pending,ready)&order=updated_at.desc&select=*',
  );
}

async function listAwaySpanBacklog(sb) {
  const rows = await sb(
    'pending_diary_changes?status=eq.pending&order=detected_at.asc&select=*',
  );
  return (rows || []).filter((r) => {
    if (r.change_type === 'habit_placement') return true;
    const id = String(r.related_id || '');
    if (id.startsWith('task_bump:MC-')) return true;
    if (id.startsWith('task_bump:audit:')) return true;
    return id === 'travel_back_fix:rosedale:2026-08-06';
  });
}

async function markPushStatus(sb, ids, status, actor) {
  if (!ids?.length) return [];
  const patch = {
    status,
    updated_at: new Date().toISOString(),
  };
  if (status === 'applied' || status === 'dismissed') {
    patch.resolved_at = new Date().toISOString();
    patch.resolved_by = actor || 'claude';
  }
  const out = [];
  for (const id of ids) {
    const rows = await sb(`gcal_push_queue?id=eq.${id}`, {
      method: 'PATCH', prefer: 'return=representation', body: patch,
    });
    if (rows?.[0]) out.push(rows[0]);
  }
  return out;
}

async function markAllPendingReady(sb, actor) {
  const open = await sb('gcal_push_queue?status=eq.pending&select=id');
  const ids = (open || []).map((r) => r.id);
  return markPushStatus(sb, ids, 'ready', actor);
}

module.exports = {
  BACKLOG_SQL_HINT,
  relatedIdForTask,
  relatedIdForHabit,
  upsertPushRow,
  listOpenPush,
  listAwaySpanBacklog,
  markPushStatus,
  markAllPendingReady,
};
