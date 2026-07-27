/**
 * One-off baseline GCal flush plan + apply.
 * DB is master; Google is downstream. dry_run never writes.
 * Calendar titles come from gcal-title-lib / DB — never queue summary text.
 */
const {
  listOpenPush, listAwaySpanBacklog, markPushStatus, collapsePushManifest,
} = require('./gcal-push-lib');
const {
  insertPrimaryEvent, patchPrimaryEvent, deletePrimaryEvent, verifyPrimaryEvent,
} = require('./gcal-write-lib');
const { ruleMapFromRows } = require('./scheduling-rules-lib');
const {
  taskGcalTitle, habitGcalTitle, travelGcalTitle, travelGcalLocation, travelGcalDescription,
  isChangelogTitle,
} = require('./gcal-title-lib');

const KIND_RANK = { complete: 0, skip: 1, move: 2, pin: 2, dismiss: 3 };

function londonHmRangeToIso(day, startHm, endHm) {
  const s = `${day}T${startHm}:00`;
  const e = `${day}T${endHm}:00`;
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

function safeTitle(candidate, fallback) {
  if (candidate && !isChangelogTitle(candidate)) return candidate;
  if (fallback && !isChangelogTitle(fallback)) return fallback;
  return null;
}

function planFromPushRow(row, prefixes, resolvedTitle) {
  const p = row.payload || {};
  const kind = row.change_kind;
  const title = safeTitle(resolvedTitle, safeTitle(p.title, null));
  const evt = p.calendar_event_id || null;

  if (kind === 'skip' || p.action === 'delete_event') {
    if (!evt) return { skip: true, reason: 'skip_without_event_id', row };
    return {
      source: 'gcal_push_queue',
      source_id: row.id,
      entity_type: row.entity_type,
      action: 'delete',
      event_id: evt,
      summary: title || row.summary || 'MC delete',
      from: null,
      to: null,
    };
  }

  if (kind === 'complete') {
    if (!evt) return { skip: true, reason: 'complete_without_event_id', row };
    return {
      source: 'gcal_push_queue',
      source_id: row.id,
      entity_type: row.entity_type,
      action: 'delete',
      event_id: evt,
      summary: title || row.summary || 'MC complete',
      from: null,
      to: null,
      note: 'complete → delete calendar block',
    };
  }

  if (kind === 'move' || kind === 'pin') {
    if (!p.new_start || !p.new_end) {
      return { skip: true, reason: 'move_missing_times', row };
    }
    if (!title) {
      return { skip: true, reason: 'move_missing_db_title', row };
    }
    if (evt) {
      const patch = { startIso: p.new_start, endIso: p.new_end, summary: title };
      if (p.location != null) patch.location = p.location;
      if (p.description != null) patch.description = p.description;
      if (row.entity_type === 'travel' && (p.block_type || p.leg_from || p.leg_to)) {
        const tb = {
          block_type: p.block_type,
          venue_name: p.venue,
          workshop_title: p.workshop_title,
          leg_from: p.leg_from,
          leg_to: p.leg_to,
          drive_minutes_used: p.drive_minutes_used,
        };
        patch.location = p.location != null ? p.location : travelGcalLocation(tb);
        patch.description = p.description != null ? p.description : travelGcalDescription(tb);
      }
      return {
        source: 'gcal_push_queue',
        source_id: row.id,
        entity_type: row.entity_type,
        action: 'patch',
        event_id: evt,
        summary: title,
        from: null,
        to: { start: p.new_start, end: p.new_end },
        patch,
      };
    }
    const insert = { summary: title, startIso: p.new_start, endIso: p.new_end };
    if (p.location) insert.location = p.location;
    if (p.description) insert.description = p.description;
    return {
      source: 'gcal_push_queue',
      source_id: row.id,
      entity_type: row.entity_type,
      action: 'insert',
      event_id: null,
      summary: title,
      from: null,
      to: { start: p.new_start, end: p.new_end },
      insert,
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
      summary: 'MC backlog delete',
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
      summary: null,
      from: null,
      to: { start: times.startIso, end: times.endIso, day: move[3] },
      patch: { startIso: times.startIso, endIso: times.endIso },
      display_id: Number(move[1]),
      related_id: row.related_id,
      needs_task_title: true,
    };
  }
  const movePrimary = /MOVE Primary event ([A-Za-z0-9_-]+) to (\S+)\s*[–-]\s*(\S+)/i.exec(action);
  if (movePrimary) {
    return {
      source: 'pending_diary_changes',
      source_id: row.id,
      entity_type: 'habit',
      action: 'patch',
      event_id: movePrimary[1],
      summary: null,
      from: null,
      to: { start: movePrimary[2], end: movePrimary[3] },
      patch: { startIso: movePrimary[2], endIso: movePrimary[3] },
      related_id: row.related_id,
      needs_habit_from_event: true,
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
        summary: null,
        from: null,
        to: { start: moveHabit[2], end: moveHabit[3] },
        patch: { startIso: moveHabit[2], endIso: moveHabit[3] },
        related_id: row.related_id,
        needs_habit_title: moveHabit[1],
      };
    }
  }
  return { skip: true, reason: 'backlog_unparsed', row };
}

function dedupePlans(plans) {
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

async function resolveQueueTitle(sb, row, prefixes) {
  const p = row.payload || {};
  if (row.entity_type === 'task') {
    const did = p.display_id || p.task_display_id;
    const tid = p.task_id;
    let task = null;
    if (tid) {
      const rows = await sb(`tasks?id=eq.${tid}&select=display_id,title,priority`);
      task = rows?.[0];
    } else if (did) {
      const rows = await sb(`tasks?display_id=eq.${did}&select=display_id,title,priority`);
      task = rows?.[0];
    }
    if (task) return taskGcalTitle(task);
  }
  if (row.entity_type === 'habit') {
    const hid = p.habit_id;
    if (hid) {
      const rows = await sb(`recurring_tasks?id=eq.${hid}&select=title`);
      if (rows?.[0]?.title) return habitGcalTitle(rows[0].title, prefixes);
    }
  }
  if (row.entity_type === 'travel') {
    const bid = String(row.related_id || '').replace(/^gcal:travel:/, '') || p.block_id;
    if (bid) {
      const rows = await sb(
        `travel_blocks?id=eq.${bid}&select=block_type,venue_name,workshop_title,leg_from,leg_to,drive_minutes_used`,
      );
      if (rows?.[0]) {
        p.block_type = p.block_type || rows[0].block_type;
        p.venue = p.venue || rows[0].venue_name;
        p.workshop_title = p.workshop_title || rows[0].workshop_title;
        p.leg_from = p.leg_from || rows[0].leg_from;
        p.leg_to = p.leg_to || rows[0].leg_to;
        p.drive_minutes_used = p.drive_minutes_used ?? rows[0].drive_minutes_used;
        return travelGcalTitle(rows[0], prefixes);
      }
    }
    if (p.block_type) return travelGcalTitle(p, prefixes);
  }
  return safeTitle(p.title, null);
}

async function buildFlushPlan(sb) {
  const rules = await sb('scheduling_rules?select=key,value');
  const ruleMap = ruleMapFromRows(rules || []);
  const prefixes = {
    habit: ruleMap.title_prefix_recurring || 'MC 🔁',
    travel: ruleMap.title_prefix_travel || 'MC 🚗',
    buffer: ruleMap.title_prefix_buffer || 'MC ⏳',
  };

  const open = await listOpenPush(sb);
  const collapsed = collapsePushManifest(open || []);
  collapsed.sort((a, b) => (KIND_RANK[a.change_kind] ?? 9) - (KIND_RANK[b.change_kind] ?? 9));

  const fromQueue = [];
  const skipped = [];
  for (const row of collapsed) {
    const resolved = await resolveQueueTitle(sb, row, prefixes);
    const plan = planFromPushRow(row, prefixes, resolved);
    if (plan.skip) skipped.push(plan);
    else fromQueue.push(plan);
  }

  const backlog = await listAwaySpanBacklog(sb);
  const fromBacklog = [];
  for (const row of backlog || []) {
    const plan = planFromBacklogRow(row);
    if (plan.skip) {
      skipped.push(plan);
      continue;
    }
    if (plan.needs_task_title && plan.display_id) {
      const tasks = await sb(
        `tasks?display_id=eq.${plan.display_id}&select=display_id,title,priority`,
      );
      if (tasks?.[0]) {
        const title = taskGcalTitle(tasks[0]);
        plan.summary = title;
        plan.patch = { ...plan.patch, summary: title };
      }
    }
    if (plan.needs_habit_title) {
      const title = habitGcalTitle(plan.needs_habit_title, prefixes);
      plan.summary = title;
      plan.patch = { ...plan.patch, summary: title };
    }
    fromBacklog.push(plan);
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
        const v = await verifyPrimaryEvent(w.event_id, {
          summary: w.patch?.summary,
          startIso: w.patch?.startIso,
          endIso: w.patch?.endIso,
        });
        if (!v.ok) {
          results.push({ ...w, ok: false, error: 'readback_mismatch', verify: v });
          continue;
        }
      } else if (w.action === 'insert') {
        const created = await insertPrimaryEvent(w.insert);
        eventId = created.id;
        const v = await verifyPrimaryEvent(eventId, {
          summary: w.insert.summary,
          startIso: w.insert.startIso,
          endIso: w.insert.endIso,
        });
        if (!v.ok) {
          results.push({ ...w, ok: false, error: 'readback_mismatch', event_id: eventId, verify: v });
          continue;
        }
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
  safeTitle,
};
