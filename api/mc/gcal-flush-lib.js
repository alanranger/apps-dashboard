/**
 * One-off baseline GCal flush plan + apply.
 * DB is master; Google is downstream. dry_run never writes.
 */
const {
  listOpenPush, listAwaySpanBacklog, markPushStatus, collapsePushManifest,
} = require('./gcal-push-lib');
const {
  insertPrimaryEvent, patchPrimaryEvent, deletePrimaryEvent,
} = require('./gcal-write-lib');
const { ruleMapFromRows } = require('./scheduling-rules-lib');

const KIND_RANK = { complete: 0, skip: 1, move: 2, pin: 2, dismiss: 3 };

function londonHmRangeToIso(day, startHm, endHm) {
  // Wall times as Europe/London → ISO via Date parsing with explicit offset guess:
  // Prefer storing already-ISO payloads; this path is for backlog text only.
  const s = `${day}T${startHm}:00`;
  const e = `${day}T${endHm}:00`;
  // Interpret as London by formatting round-trip via Intl offset at that local noon.
  const offsetMin = londonOffsetMinutes(day);
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const oh = String(Math.floor(abs / 60)).padStart(2, '0');
  const om = String(abs % 60).padStart(2, '0');
  const off = `${sign}${oh}:${om}`;
  return {
    startIso: new Date(`${s}${off}`).toISOString(),
    endIso: new Date(`${e}${off}`).toISOString(),
  };
}

function londonOffsetMinutes(ymd) {
  const utc = new Date(`${ymd}T12:00:00Z`);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', timeZoneName: 'shortOffset', hour: '2-digit',
  }).formatToParts(utc);
  const tz = parts.find((p) => p.type === 'timeZoneName')?.value || 'GMT';
  const m = /GMT([+-])(\d+)(?::?(\d+))?/i.exec(tz);
  if (!m) return 0;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * ((Number(m[2]) || 0) * 60 + (Number(m[3]) || 0));
}

function planFromPushRow(row, prefixes) {
  const p = row.payload || {};
  const kind = row.change_kind;
  const title = p.title || row.summary || 'MC item';
  const evt = p.calendar_event_id || null;

  if (kind === 'skip' || p.action === 'delete_event') {
    if (!evt) return { skip: true, reason: 'skip_without_event_id', row };
    return {
      source: 'gcal_push_queue',
      source_id: row.id,
      entity_type: row.entity_type,
      action: 'delete',
      event_id: evt,
      summary: title,
      from: null,
      to: null,
    };
  }

  if (kind === 'complete') {
    if (!evt) return { skip: true, reason: 'complete_without_event_id', row };
    // Mark done in calendar by deleting the block (DB already completed).
    return {
      source: 'gcal_push_queue',
      source_id: row.id,
      entity_type: row.entity_type,
      action: 'delete',
      event_id: evt,
      summary: title,
      from: null,
      to: null,
      note: 'complete → delete calendar block',
    };
  }

  if (kind === 'move' || kind === 'pin') {
    if (!p.new_start || !p.new_end) {
      return { skip: true, reason: 'move_missing_times', row };
    }
    const prefix = row.entity_type === 'travel'
      ? (prefixes.travel || 'MC 🚗')
      : row.entity_type === 'habit'
        ? (prefixes.habit || 'MC 🔁')
        : '';
    const summary = prefix ? `${prefix} ${title}`.replace(/\s+/g, ' ').trim() : title;
    if (evt) {
      return {
        source: 'gcal_push_queue',
        source_id: row.id,
        entity_type: row.entity_type,
        action: 'patch',
        event_id: evt,
        summary,
        from: null,
        to: { start: p.new_start, end: p.new_end },
        patch: { startIso: p.new_start, endIso: p.new_end, summary },
      };
    }
    return {
      source: 'gcal_push_queue',
      source_id: row.id,
      entity_type: row.entity_type,
      action: 'insert',
      event_id: null,
      summary,
      from: null,
      to: { start: p.new_start, end: p.new_end },
      insert: { summary, startIso: p.new_start, endIso: p.new_end },
      habit_id: p.habit_id || null,
      task_id: p.task_id || null,
      ideal_date: p.ideal_date || null,
    };
  }

  return { skip: true, reason: `unsupported_kind:${kind}`, row };
}

function planFromBacklogRow(row) {
  const action = String(row.proposed_action || '');
  const del = /DELETE Primary event ([A-Za-z0-9_-]+)/i.exec(action);
  if (del) {
    return {
      source: 'pending_diary_changes',
      source_id: row.id,
      entity_type: 'habit',
      action: 'delete',
      event_id: del[1],
      summary: row.summary || action.slice(0, 80),
      from: null,
      to: null,
      related_id: row.related_id,
    };
  }
  const move = /MOVE MC-(\d+).*?event ([A-Za-z0-9_-]+) to (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})[–-](\d{2}:\d{2})/i
    .exec(action);
  if (move) {
    const times = londonHmRangeToIso(move[3], move[4], move[5]);
    return {
      source: 'pending_diary_changes',
      source_id: row.id,
      entity_type: 'task',
      action: 'patch',
      event_id: move[2],
      summary: row.summary || `MC-${move[1]}`,
      from: null,
      to: { start: times.startIso, end: times.endIso, day: move[3] },
      patch: { startIso: times.startIso, endIso: times.endIso },
      display_id: Number(move[1]),
      related_id: row.related_id,
    };
  }
  const moveHabit = /MOVE\/CREATE habit "([^"]+)" block to (\S+) [–-] (\S+)/i.exec(action);
  if (moveHabit) {
    const evt = /event_id=([A-Za-z0-9_-]+)/i.exec(action);
    if (evt) {
      return {
        source: 'pending_diary_changes',
        source_id: row.id,
        entity_type: 'habit',
        action: 'patch',
        event_id: evt[1],
        summary: moveHabit[1],
        from: null,
        to: { start: moveHabit[2], end: moveHabit[3] },
        patch: { startIso: moveHabit[2], endIso: moveHabit[3] },
        related_id: row.related_id,
      };
    }
  }
  return { skip: true, reason: 'backlog_unparsed', row };
}

function dedupePlans(plans) {
  // Prefer queue over backlog for same event_id + action.
  const byKey = new Map();
  for (const p of plans) {
    if (p.skip) continue;
    const key = p.event_id
      ? `${p.action}:${p.event_id}`
      : `insert:${p.source_id}`;
    const prev = byKey.get(key);
    if (!prev) { byKey.set(key, p); continue; }
    if (prev.source === 'pending_diary_changes' && p.source === 'gcal_push_queue') {
      byKey.set(key, p);
    }
  }
  return [...byKey.values()];
}

async function buildFlushPlan(sb) {
  const rules = await sb('scheduling_rules?select=key,value');
  const ruleMap = ruleMapFromRows(rules || []);
  const prefixes = {
    habit: ruleMap.title_prefix_recurring || 'MC 🔁',
    travel: ruleMap.title_prefix_travel || 'MC 🚗',
  };

  const open = await listOpenPush(sb);
  const collapsed = collapsePushManifest(open || []);
  collapsed.sort((a, b) => (KIND_RANK[a.change_kind] ?? 9) - (KIND_RANK[b.change_kind] ?? 9));

  const fromQueue = [];
  const skipped = [];
  for (const row of collapsed) {
    const plan = planFromPushRow(row, prefixes);
    if (plan.skip) skipped.push(plan);
    else fromQueue.push(plan);
  }

  const backlog = await listAwaySpanBacklog(sb);
  const fromBacklog = [];
  for (const row of backlog || []) {
    const plan = planFromBacklogRow(row);
    if (plan.skip) skipped.push(plan);
    else fromBacklog.push(plan);
  }

  const writes = dedupePlans(fromQueue.concat(fromBacklog));
  writes.sort((a, b) => {
    const ra = a.action === 'delete' ? 0 : a.action === 'patch' ? 1 : 2;
    const rb = b.action === 'delete' ? 0 : b.action === 'patch' ? 1 : 2;
    return ra - rb;
  });

  return {
    dry_run: true,
    queue_raw: (open || []).length,
    queue_collapsed: collapsed.length,
    backlog_rows: (backlog || []).length,
    write_count: writes.length,
    skipped_count: skipped.length,
    writes,
    skipped: skipped.map((s) => ({
      reason: s.reason,
      source: s.row?.related_id || s.row?.id || null,
      summary: s.row?.summary || null,
    })),
  };
}

async function applyFlushPlan(sb, plan, actor) {
  const results = [];
  for (const w of plan.writes || []) {
    try {
      let eventId = w.event_id || null;
      if (w.action === 'delete') {
        await deletePrimaryEvent(w.event_id);
      } else if (w.action === 'patch') {
        await patchPrimaryEvent(w.event_id, w.patch);
      } else if (w.action === 'insert') {
        const created = await insertPrimaryEvent(w.insert);
        eventId = created.id;
        if (w.habit_id && w.ideal_date) {
          await sb(
            `recurring_log?recurring_task_id=eq.${w.habit_id}&ideal_date=eq.${w.ideal_date}`,
            {
              method: 'PATCH', prefer: 'return=minimal',
              body: { calendar_event_id: eventId },
            },
          );
        }
        if (w.task_id) {
          await sb(`tasks?id=eq.${w.task_id}`, {
            method: 'PATCH', prefer: 'return=minimal',
            body: { calendar_event_id: eventId },
          });
        }
      } else {
        results.push({ ...w, ok: false, error: 'unknown_action' });
        continue;
      }

      if (w.source === 'gcal_push_queue' && w.source_id) {
        await markPushStatus(sb, [w.source_id], 'applied', actor || 'cursor-flush');
      }
      if (w.source === 'pending_diary_changes' && w.source_id) {
        await sb(`pending_diary_changes?id=eq.${w.source_id}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: {
            status: 'applied',
            resolved_at: new Date().toISOString(),
            resolved_by: actor || 'cursor-flush',
          },
        });
      }
      results.push({ ...w, ok: true, event_id: eventId });
    } catch (e) {
      results.push({ ...w, ok: false, error: e.message, status: e.status || null });
    }
  }
  return {
    applied: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };
}

module.exports = {
  buildFlushPlan,
  applyFlushPlan,
  planFromPushRow,
  planFromBacklogRow,
  dedupePlans,
};
