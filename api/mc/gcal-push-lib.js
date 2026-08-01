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

function relatedIdForHabit(habitId, idealDate, calendarEventId) {
  // Always key by ideal — evt:* lineages caused CREATE patches on dead IDs
  // while a parallel ideal-keyed insert created duplicates.
  return `gcal:habit:${habitId}:${idealDate}`;
}

function habitIdFromRelated(relatedId) {
  const m = String(relatedId || '').match(/^gcal:habit:([^:]+):/);
  return m ? m[1] : null;
}

function londonDayFromIso(iso) {
  if (!iso) return null;
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(iso));
  } catch (e) {
    return String(iso).slice(0, 10);
  }
}

/**
 * Terminal habit actions (complete/skip) must supersede earlier move/pin rows for the
 * same occurrence — related_id alone is not enough when ideal_date drifted.
 */
async function supersedeSiblingHabitRows(sb, {
  habitId, keepRelatedId, calendarEventId, idealDate, scheduledDate, actor,
}) {
  const open = await sb(
    'gcal_push_queue?status=in.(pending,ready)&entity_type=eq.habit&select=id,related_id,change_kind,payload,status',
  );
  const ids = [];
  for (const row of open || []) {
    if (!row?.id || row.related_id === keepRelatedId) continue;
    const hid = row.payload?.habit_id || habitIdFromRelated(row.related_id);
    if (hid !== habitId) continue;
    const p = row.payload || {};
    const sameEvt = !!(calendarEventId && p.calendar_event_id && p.calendar_event_id === calendarEventId);
    const sameIdeal = !!(idealDate && (p.ideal_date === idealDate
      || String(row.related_id).endsWith(`:${idealDate}`)));
    const moveOntoScheduled = row.change_kind === 'move' && scheduledDate
      && londonDayFromIso(p.new_start) === scheduledDate;
    const moveSameIdeal = row.change_kind === 'move' && idealDate && p.ideal_date === idealDate;
    if (sameEvt || sameIdeal || moveOntoScheduled || moveSameIdeal) ids.push(row.id);
  }
  if (!ids.length) return [];
  return markPushStatus(sb, ids, 'dismissed', actor || 'supersede');
}

/**
 * Flush-time safety net: for each habit occurrence, keep one net row.
 * Priority: complete > skip > move/pin (latest updated_at wins within kind).
 */
function collapsePushManifest(items) {
  const rank = { complete: 3, skip: 2, move: 1, pin: 1 };
  const best = new Map();
  for (const row of items || []) {
    if (row.entity_type !== 'habit') {
      best.set(`row:${row.id || row.related_id}`, row);
      continue;
    }
    const hid = row.payload?.habit_id || habitIdFromRelated(row.related_id);
    const evt = row.payload?.calendar_event_id || null;
    const ideal = row.payload?.ideal_date || null;
    const sched = row.payload?.scheduled_date || londonDayFromIso(row.payload?.new_start) || null;
    const occ = evt ? `evt:${evt}` : `ideal:${ideal || sched || row.related_id}`;
    const key = `habit:${hid}:${occ}`;
    const prev = best.get(key);
    if (!prev) {
      best.set(key, row);
      continue;
    }
    const pr = rank[row.change_kind] || 0;
    const pp = rank[prev.change_kind] || 0;
    if (pr > pp) best.set(key, row);
    else if (pr === pp && String(row.updated_at || '') > String(prev.updated_at || '')) {
      best.set(key, row);
    }
  }
  // Second pass: if a complete/skip exists for habit+evt OR habit with overlapping ideal/sched,
  // drop leftover moves that only share habit_id + calendar_event_id / scheduled day.
  const list = [...best.values()];
  const terminals = list.filter((r) => r.entity_type === 'habit'
    && (r.change_kind === 'complete' || r.change_kind === 'skip'));
  return list.filter((row) => {
    if (row.entity_type !== 'habit' || row.change_kind === 'complete' || row.change_kind === 'skip') {
      return true;
    }
    const hid = row.payload?.habit_id || habitIdFromRelated(row.related_id);
    const evt = row.payload?.calendar_event_id || null;
    const moveDay = londonDayFromIso(row.payload?.new_start);
    const ideal = row.payload?.ideal_date || null;
    return !terminals.some((t) => {
      const th = t.payload?.habit_id || habitIdFromRelated(t.related_id);
      if (th !== hid) return false;
      const te = t.payload?.calendar_event_id || null;
      if (evt && te && evt === te) return true;
      const ts = t.payload?.scheduled_date || t.payload?.completed_on || null;
      const ti = t.payload?.ideal_date || null;
      if (moveDay && ts && moveDay === ts) return true;
      if (ideal && ti && ideal === ti) return true;
      return false;
    });
  });
}

async function upsertPushRow(sb, row) {
  // Only collapse onto OPEN rows. Reusing an applied row marked the write "done"
  // while hydrate could no-op against the wrong event — queue looked empty, GCal stale.
  const existing = await sb(
    `gcal_push_queue?related_id=eq.${encodeURIComponent(row.related_id)}`
    + '&status=in.(pending,ready)&select=id,status&order=updated_at.desc&limit=1',
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
  supersedeSiblingHabitRows,
  collapsePushManifest,
  habitIdFromRelated,
};
