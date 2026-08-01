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

/** Strip trailing junk (e.g. "Z." from proposed_action prose) and normalise. */
function sanitizeIso(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim().replace(/\.+$/, '');
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
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
    // Done items stay on the day at completion time (match Mission Control diary).
    // Only delete when explicitly requested (e.g. skip-style cleanup).
    if (p.action === 'delete_event' && !p.scheduled_start) {
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
        note: 'complete → delete (explicit)',
      };
    }
    const startIso = sanitizeIso(p.scheduled_start || p.new_start || null);
    const endIso = sanitizeIso(p.scheduled_end || p.new_end || null);
    if (!startIso || !endIso) {
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
        note: 'complete → delete (no times)',
      };
    }
    const doneTitle = title || row.summary || 'MC complete';
    const idealDate = p.ideal_date || p.scheduled_date || p.completed_on || null;
    if (evt) {
      return {
        source: 'gcal_push_queue',
        source_id: row.id,
        entity_type: row.entity_type,
        change_kind: 'complete',
        action: 'patch',
        event_id: evt,
        summary: doneTitle,
        from: null,
        to: { start: startIso, end: endIso },
        patch: { startIso, endIso, summary: doneTitle },
        task_id: p.task_id || null,
        display_id: p.display_id || null,
        habit_id: p.habit_id || null,
        ideal_date: idealDate,
        note: 'complete → move to completion slot',
      };
    }
    return {
      source: 'gcal_push_queue',
      source_id: row.id,
      entity_type: row.entity_type,
      change_kind: 'complete',
      action: 'insert',
      event_id: null,
      summary: doneTitle,
      from: null,
      to: { start: startIso, end: endIso },
      insert: { summary: doneTitle, startIso, endIso },
      task_id: p.task_id || null,
      display_id: p.display_id || null,
      habit_id: p.habit_id || null,
      ideal_date: idealDate,
      note: 'complete → create at completion slot',
    };
  }

  if (kind === 'move' || kind === 'pin') {
    const startIso = sanitizeIso(p.new_start || p.startIso);
    const endIso = sanitizeIso(p.new_end || p.endIso);
    const eventId = evt || p.event_id || null;
    if (!startIso || !endIso) {
      return { skip: true, reason: 'move_missing_times', row };
    }
    // Time-only Primary slides (Heal gap) may have no DB title — patch times only.
    if (!title && !eventId) {
      return { skip: true, reason: 'move_missing_db_title', row };
    }
    if (eventId) {
      const patch = { startIso, endIso };
      if (title) patch.summary = title;
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
        event_id: eventId,
        summary: title || row.summary || 'MC move',
        from: null,
        to: { start: startIso, end: endIso },
        patch,
        task_id: p.task_id || null,
        display_id: p.display_id || p.task_display_id || null,
        habit_id: p.habit_id || null,
        ideal_date: p.ideal_date || null,
        travel_block_id: p.block_id || null,
      };
    }
    const insert = { summary: title, startIso, endIso };
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
      to: { start: startIso, end: endIso },
      insert,
      habit_id: p.habit_id || null,
      task_id: p.task_id || null,
      display_id: p.display_id || p.task_display_id || null,
      ideal_date: p.ideal_date || null,
      travel_block_id: p.block_id || null,
    };
  }

  return { skip: true, reason: `unsupported_kind:${kind}`, row };
}

function planFromBacklogRow(row) {
  const action = String(row.proposed_action || '');
  const tie = /recurring_task_id=([0-9a-f-]{36}).*?ideal_date=(\d{4}-\d{2}-\d{2})/i.exec(action)
    || /habit_place:([0-9a-f-]{36}):(\d{4}-\d{2}-\d{2})/i.exec(String(row.related_id || ''));
  const habitId = tie?.[1] || null;
  const idealDate = tie?.[2] || null;

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
      habit_id: habitId,
      ideal_date: idealDate,
      sync_recurring_log: !!habitId,
    };
  }

  const createHabit = /CREATE Primary block "([^"]+)" (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})[–-](\d{2}:\d{2})/i
    .exec(action);
  if (createHabit && habitId) {
    const times = londonHmRangeToIso(createHabit[2], createHabit[3], createHabit[4]);
    return {
      source: 'pending_diary_changes',
      source_id: row.id,
      entity_type: 'habit',
      action: 'insert',
      event_id: null,
      summary: null,
      from: null,
      to: { start: times.startIso, end: times.endIso, day: createHabit[2] },
      insert: { summary: null, startIso: times.startIso, endIso: times.endIso },
      related_id: row.related_id,
      habit_id: habitId,
      ideal_date: idealDate,
      needs_habit_title: createHabit[1],
      sync_recurring_log: true,
    };
  }

  const moveEvt = /MOVE event ([A-Za-z0-9_-]+) to (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})[–-](\d{2}:\d{2})/i
    .exec(action);
  if (moveEvt) {
    const times = londonHmRangeToIso(moveEvt[2], moveEvt[3], moveEvt[4]);
    return {
      source: 'pending_diary_changes',
      source_id: row.id,
      entity_type: 'habit',
      action: 'patch',
      event_id: moveEvt[1],
      summary: null,
      from: null,
      to: { start: times.startIso, end: times.endIso, day: moveEvt[2] },
      patch: { startIso: times.startIso, endIso: times.endIso },
      related_id: row.related_id,
      habit_id: habitId,
      ideal_date: idealDate,
      sync_recurring_log: !!habitId,
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
  const movePrimary = /MOVE Primary event ([A-Za-z0-9_-]+) to (\S+?)\s*[–-]\s*(\S+?)(?:\.|\s|$)/i.exec(action);
  if (movePrimary) {
    const startIso = String(movePrimary[2] || '').replace(/\.+$/, '');
    const endIso = String(movePrimary[3] || '').replace(/\.+$/, '');
    return {
      source: 'pending_diary_changes',
      source_id: row.id,
      entity_type: 'habit',
      action: 'patch',
      event_id: movePrimary[1],
      summary: null,
      from: null,
      to: { start: startIso, end: endIso },
      patch: { startIso, endIso },
      related_id: row.related_id,
      habit_id: habitId,
      ideal_date: idealDate,
      needs_habit_from_event: true,
      sync_recurring_log: !!habitId,
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
        habit_id: habitId,
        ideal_date: idealDate,
        needs_habit_title: moveHabit[1],
        sync_recurring_log: !!habitId,
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

function parseDiaryPinChange(change) {
  const m = String(change || '').match(/^diary_pin:([^|]+)\|(.+)$/);
  if (!m) return null;
  return { startIso: m[1].trim(), endIso: m[2].trim() };
}

/**
 * Live DB times at plan/write moment — never trust stale queue/backlog payloads.
 * Tasks → tasks.scheduled_*; habits → recurring_log diary_pin; travel → travel_blocks.
 */
async function liveDbSlot(sb, w, prefixes) {
  if (w.action === 'delete') return null;
  if (w.entity_type === 'task') {
    const tid = w.task_id || null;
    const did = w.display_id || null;
    let task = null;
    if (tid) {
      const rows = await sb(
        `tasks?id=eq.${tid}&select=id,display_id,title,priority,scheduled_start,scheduled_end,calendar_event_id`,
      );
      task = rows?.[0];
    } else if (did != null) {
      const rows = await sb(
        `tasks?display_id=eq.${Number(did)}&select=id,display_id,title,priority,scheduled_start,scheduled_end,calendar_event_id`,
      );
      task = rows?.[0];
    }
    if (!task?.scheduled_start || !task?.scheduled_end) return { error: 'task_missing_db_times' };
    return {
      startIso: new Date(task.scheduled_start).toISOString(),
      endIso: new Date(task.scheduled_end).toISOString(),
      summary: taskGcalTitle(task),
      event_id: task.calendar_event_id || w.event_id || null,
      task_id: task.id,
      display_id: task.display_id,
      live_from: 'tasks',
    };
  }
  if (w.entity_type === 'habit' && w.habit_id) {
    const ideal = w.ideal_date || null;
    let q = `recurring_log?recurring_task_id=eq.${w.habit_id}&select=change,scheduled_date,ideal_date,calendar_event_id,at&order=at.desc&limit=8`;
    if (ideal) {
      q = `recurring_log?recurring_task_id=eq.${w.habit_id}&ideal_date=eq.${ideal}`
        + '&select=change,scheduled_date,ideal_date,calendar_event_id,at&order=at.desc&limit=5';
    }
    const logs = await sb(q);
    const habits = await sb(`recurring_tasks?id=eq.${w.habit_id}&select=title`);
    const title = habits?.[0]?.title ? habitGcalTitle(habits[0].title, prefixes) : w.summary;

    // Prefer completion stamp for this ideal (never a pin from another month).
    const done = (logs || []).map((l) => {
      const m = String(l.change || '').match(
        /^completed\s+(\d{4}-\d{2}-\d{2})(?:\|actual=(\d+))?(?:\|at=([^|]+))?/i,
      );
      if (!m || !m[3] || !Number.isFinite(Date.parse(m[3]))) return null;
      const startIso = new Date(m[3]).toISOString();
      const mins = m[2] != null ? Number(m[2]) : 30;
      return {
        l,
        startIso,
        endIso: new Date(Date.parse(startIso) + mins * 60000).toISOString(),
      };
    }).find(Boolean);
    if (done) {
      return {
        startIso: done.startIso,
        endIso: done.endIso,
        summary: title,
        event_id: done.l.calendar_event_id || w.event_id || null,
        live_from: 'recurring_log_complete',
      };
    }

    const pin = (logs || []).map((l) => ({ l, pin: parseDiaryPinChange(l.change) })).find((x) => x.pin);
    if (pin?.pin) {
      return {
        startIso: new Date(pin.pin.startIso).toISOString(),
        endIso: new Date(pin.pin.endIso).toISOString(),
        summary: title,
        event_id: pin.l.calendar_event_id || w.event_id || null,
        live_from: 'recurring_log',
      };
    }
    return null;
  }
  if (w.entity_type === 'travel') {
    const bid = w.travel_block_id || String(w.related_id || '').replace(/^gcal:travel:/, '') || null;
    if (!bid) return null;
    const rows = await sb(
      `travel_blocks?id=eq.${bid}&select=id,starts_at,ends_at,calendar_event_id,block_type,venue_name,workshop_title,leg_from,leg_to,drive_minutes_used`,
    );
    const row = rows?.[0];
    if (!row?.starts_at || !row?.ends_at) return { error: 'travel_missing_db_times' };
    return {
      startIso: new Date(row.starts_at).toISOString(),
      endIso: new Date(row.ends_at).toISOString(),
      summary: travelGcalTitle(row, prefixes),
      event_id: row.calendar_event_id || w.event_id || null,
      live_from: 'travel_blocks',
    };
  }
  return null;
}

function applyLiveSlot(w, live) {
  if (!live || live.error) return w;
  const next = { ...w, live_from: live.live_from };
  if (live.summary) next.summary = live.summary;
  if (live.event_id) next.event_id = live.event_id;
  if (live.task_id) next.task_id = live.task_id;
  if (live.display_id != null) next.display_id = live.display_id;
  next.to = { start: live.startIso, end: live.endIso, day: String(live.startIso).slice(0, 10) };
  if (w.action === 'patch') {
    next.patch = {
      ...(w.patch || {}),
      startIso: live.startIso,
      endIso: live.endIso,
      summary: live.summary || w.patch?.summary || w.summary,
    };
  }
  if (w.action === 'insert') {
    next.insert = {
      ...(w.insert || {}),
      startIso: live.startIso,
      endIso: live.endIso,
      summary: live.summary || w.insert?.summary || w.summary,
    };
  }
  return next;
}

async function hydrateWritesFromDb(sb, writes, prefixes) {
  const out = [];
  for (const w of writes || []) {
    if (w.action === 'delete') {
      out.push(w);
      continue;
    }
    // Habit complete payloads already carry completion-slot times. liveDbSlot only
    // understands diary_pin and would steal a different month's pin (wrong event_id).
    if (w.change_kind === 'complete' || String(w.note || '').startsWith('complete')) {
      out.push(w);
      continue;
    }
    const live = await liveDbSlot(sb, w, prefixes);
    if (live?.error) {
      out.push({ ...w, skip: true, reason: live.error });
      continue;
    }
    out.push(live ? applyLiveSlot(w, live) : w);
  }
  return out.filter((w) => !w.skip);
}

async function flagVerifyFail(sb, w, verify) {
  if (w.source !== 'gcal_push_queue' || !w.source_id) return;
  const detail = `VERIFY_FAILED titleOk=${verify?.titleOk} startOk=${verify?.startOk} endOk=${verify?.endOk}`;
  await sb(`gcal_push_queue?id=eq.${w.source_id}`, {
    method: 'PATCH', prefer: 'return=minimal',
    body: {
      summary: `${detail} · ${String(w.summary || '').slice(0, 120)}`,
      proposed_action: `${detail}. expect=${JSON.stringify(verify?.expect || {})} live=${JSON.stringify(verify?.live || {})}`,
      updated_at: new Date().toISOString(),
    },
  });
}

async function buildFlushPlan(sb, opts = {}) {
  const includeBacklog = opts.includeBacklog !== false;
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

  const fromBacklog = [];
  let backlogRows = 0;
  if (includeBacklog) {
    const backlog = await listAwaySpanBacklog(sb);
    backlogRows = (backlog || []).length;
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
        if (plan.insert) plan.insert = { ...plan.insert, summary: title };
      }
      fromBacklog.push(plan);
    }
  }

  const writes = dedupePlans(fromQueue.concat(fromBacklog));
  writes.sort((a, b) => {
    const ra = a.action === 'delete' ? 0 : a.action === 'patch' ? 1 : 2;
    const rb = b.action === 'delete' ? 0 : b.action === 'patch' ? 1 : 2;
    return ra - rb;
  });

  const hydrated = await hydrateWritesFromDb(sb, writes, prefixes);
  const skippedLive = writes.length - hydrated.length;

  return {
    dry_run: true,
    include_backlog: includeBacklog,
    live_db_times: true,
    queue_raw: (open || []).length,
    queue_collapsed: collapsed.length,
    backlog_rows: backlogRows,
    write_count: hydrated.length,
    skipped_count: skipped.length + skippedLive,
    writes: hydrated,
    skipped: skipped.map((s) => ({
      reason: s.reason,
      source: s.row?.related_id || s.row?.id || null,
      summary: s.row?.summary || null,
    })),
  };
}

async function syncRecurringLogAfterFlush(sb, w, eventId) {
  if (!w.sync_recurring_log || !w.habit_id || !w.ideal_date) return;
  const startIso = w.patch?.startIso || w.insert?.startIso || w.to?.start || null;
  const endIso = w.patch?.endIso || w.insert?.endIso || w.to?.end || null;
  const existing = await sb(
    `recurring_log?recurring_task_id=eq.${w.habit_id}&ideal_date=eq.${w.ideal_date}`
    + '&select=id&order=at.desc&limit=1',
  );
  if (w.action === 'delete') {
    if (existing?.[0]?.id) {
      await sb(`recurring_log?id=eq.${existing[0].id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: {
          change: `skipped ${w.ideal_date}|gcal_flush_delete`,
          calendar_event_id: null,
          scheduled_date: null,
          roll_reason: 'gcal_flush_sync',
        },
      });
    }
    return;
  }
  if (!startIso || !endIso) return;
  const day = String(w.to?.day || startIso).slice(0, 10);
  const scheduled = /^\d{4}-\d{2}-\d{2}$/.test(day)
    ? day
    : new Date(startIso).toISOString().slice(0, 10);
  const body = {
    change: `diary_pin:${startIso}|${endIso}`,
    scheduled_date: scheduled,
    calendar_event_id: eventId || w.event_id || null,
    roll_reason: 'gcal_flush_sync',
    ideal_date: w.ideal_date,
    projection_key: `diary:${w.habit_id}:${w.ideal_date}`,
  };
  if (existing?.[0]?.id) {
    await sb(`recurring_log?id=eq.${existing[0].id}`, {
      method: 'PATCH', prefer: 'return=minimal', body,
    });
  } else {
    await sb('recurring_log', {
      method: 'POST', prefer: 'return=minimal',
      body: {
        recurring_task_id: w.habit_id,
        actor: 'cursor',
        ...body,
      },
    });
  }
}

async function applyFlushPlan(sb, plan, actor, opts = {}) {
  const results = [];
  const actorSafe = ['alan', 'claude', 'cursor', 'external', 'system'].includes(actor)
    ? actor
    : 'cursor';
  const rules = await sb('scheduling_rules?select=key,value');
  const ruleMap = ruleMapFromRows(rules || []);
  const prefixes = {
    habit: ruleMap.title_prefix_recurring || 'MC 🔁',
    travel: ruleMap.title_prefix_travel || 'MC 🚗',
    buffer: ruleMap.title_prefix_buffer || 'MC ⏳',
  };
  const allWrites = plan.writes || [];
  const limit = Number(opts.limit) > 0 ? Math.min(80, Number(opts.limit)) : allWrites.length;
  const batch = allWrites.slice(0, limit);
  const liveWrites = await hydrateWritesFromDb(sb, batch, prefixes);

  for (const w of liveWrites) {
    try {
      let eventId = w.event_id || null;
      if (w.action === 'delete') {
        await deletePrimaryEvent(w.event_id);
      } else if (w.action === 'patch') {
        if (!w.patch?.startIso || !w.patch?.endIso) {
          results.push({ ...w, ok: false, error: 'patch_missing_live_times' });
          continue;
        }
        try {
          await patchPrimaryEvent(w.event_id, w.patch);
        } catch (patchErr) {
          // Dead event id → recreate instead of failing the pin forever.
          if (patchErr.status === 404 || patchErr.status === 410) {
            const insert = {
              summary: w.patch.summary || w.summary,
              startIso: w.patch.startIso,
              endIso: w.patch.endIso,
            };
            if (w.patch.location) insert.location = w.patch.location;
            if (w.patch.description) insert.description = w.patch.description;
            const created = await insertPrimaryEvent(insert);
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
            if (w.travel_block_id) {
              await sb(`travel_blocks?id=eq.${w.travel_block_id}`, {
                method: 'PATCH', prefer: 'return=minimal',
                body: { calendar_event_id: eventId },
              });
            }
            await syncRecurringLogAfterFlush(sb, w, eventId);
            if (w.source === 'gcal_push_queue' && w.source_id) {
              await markPushStatus(sb, [w.source_id], 'applied', actorSafe);
            }
            results.push({ ...w, ok: true, event_id: eventId, recovered: 'insert_after_404' });
            continue;
          }
          throw patchErr;
        }
        const v = await verifyPrimaryEvent(w.event_id, {
          summary: w.patch?.summary,
          startIso: w.patch?.startIso,
          endIso: w.patch?.endIso,
        });
        if (!v.ok) {
          await flagVerifyFail(sb, w, v);
          results.push({ ...w, ok: false, error: 'readback_mismatch', verify: v });
          continue;
        }
      } else if (w.action === 'insert') {
        if (!w.insert?.summary) {
          results.push({ ...w, ok: false, error: 'insert_missing_title' });
          continue;
        }
        const created = await insertPrimaryEvent(w.insert);
        eventId = created.id;
        const v = await verifyPrimaryEvent(eventId, {
          summary: w.insert.summary,
          startIso: w.insert.startIso,
          endIso: w.insert.endIso,
        });
        if (!v.ok) {
          await flagVerifyFail(sb, w, v);
          results.push({ ...w, ok: false, error: 'readback_mismatch', event_id: eventId, verify: v });
          continue;
        }
        if (w.habit_id && w.ideal_date && !w.sync_recurring_log) {
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
        if (w.travel_block_id) {
          await sb(`travel_blocks?id=eq.${w.travel_block_id}`, {
            method: 'PATCH', prefer: 'return=minimal',
            body: { calendar_event_id: eventId },
          });
        }
      } else {
        results.push({ ...w, ok: false, error: 'unknown_action' });
        continue;
      }

      await syncRecurringLogAfterFlush(sb, w, eventId);

      if (w.source === 'gcal_push_queue' && w.source_id) {
        await markPushStatus(sb, [w.source_id], 'applied', actorSafe);
      }
      if (w.source === 'pending_diary_changes' && w.source_id) {
        await sb(`pending_diary_changes?id=eq.${w.source_id}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: {
            status: 'applied',
            resolved_at: new Date().toISOString(),
            resolved_by: actorSafe,
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
    batch_size: batch.length,
    remaining_planned: Math.max(0, allWrites.length - batch.length),
  };
}

module.exports = {
  buildFlushPlan,
  applyFlushPlan,
  planFromPushRow,
  planFromBacklogRow,
  syncRecurringLogAfterFlush,
  dedupePlans,
  safeTitle,
  hydrateWritesFromDb,
  liveDbSlot,
};
