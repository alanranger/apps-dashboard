/**
 * Visual conflict resolver — load one day + resolve overlap by moving A or B.
 * DB + push queue only (no Calendar unless auto-sync on).
 */
const { isoToLondonDate, isoToLondonMinutes, addDays, ruleMapFromRows } = require('./scheduling-rules-lib');
const {
  awaySpansFromTravelBlocks, tasksToBlocks, habitLogsToBlocks, travelToBlocks, busyToBlocks,
  indexGcalEventsById, applyGcalBaselineTimes, untiedMcBlocks,
} = require('./diary-lib');
const {
  trySlotOnDay, londonYmdHmToUtcMs, dayBlockedForPlacement,
} = require('./habit-placer-lib');
const { relatedIdForTask, relatedIdForHabit, upsertPushRow, supersedeSiblingHabitRows } = require('./gcal-push-lib');
const { fetchHorizonEvents, gcalConfigured } = require('./gcal-lib');
const { splitMcAndBusy } = require('./rule-breach-lib');
const { priorityRank } = require('./priority-lib');

const AXIS_START = 7 * 60;
const AXIS_END = 23 * 60;

function parseOverlapRelated(relatedId) {
  const m = String(relatedId || '').match(
    /^breach:overlap:([^:]+):([^:]+):(\d{4}-\d{2}-\d{2})$/,
  );
  if (!m) return null;
  return { idA: m[1], idB: m[2], day: m[3] };
}

function hmLabel(mins) {
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

function slimBlock(b, highlight) {
  const taskId = b.task_id || (String(b.id || '').startsWith('task:') ? String(b.id).slice(5) : null);
  return {
    id: b.id,
    kind: b.kind,
    title: b.title,
    start_min: b.start_min,
    end_min: b.end_min,
    day: b.day,
    habit_id: b.habit_id || null,
    task_id: taskId,
    display_id: b.display_id || null,
    calendar_event_id: b.calendar_event_id || null,
    ideal_date: b.ideal_date || null,
    priority: b.priority || null,
    editable: !!b.editable,
    highlight: highlight || null,
    movable: !!(
      b.editable
      && !b.done
      && b.kind !== 'travel'
      && (b.habit_id || taskId || b.display_id != null || b.calendar_event_id)
    ),
  };
}

async function loadDaySnapshot(sb, day) {
  const timeMin = `${day}T00:00:00.000Z`;
  const timeMax = `${addDays(day, 1)}T00:00:00.000Z`;
  const [tasks, travel, habits, logs, rules] = await Promise.all([
    sb(`tasks?select=id,display_id,title,state,priority,scheduled_start,scheduled_end,slot_pinned,calendar_event_id,est_minutes&scheduled_start=gte.${timeMin}&scheduled_start=lt.${timeMax}`),
    sb(`travel_blocks?select=*&starts_at=gte.${timeMin}&starts_at=lt.${timeMax}`),
    sb('recurring_tasks?select=id,title,duration_min,ideal_time,priority,active,last_done&active=eq.true'),
    sb(`recurring_log?select=id,recurring_task_id,ideal_date,scheduled_date,calendar_event_id,change,at&scheduled_date=eq.${day}`),
    sb('scheduling_rules?select=key,value'),
  ]);
  const ruleMap = ruleMapFromRows(rules || []);
  const habitMap = new Map((habits || []).map((h) => [h.id, h]));
  let busyBlocks = [];
  let mcEvents = [];
  let eventById = new Map();
  const tied = new Set([
    ...(tasks || []).map((t) => t.calendar_event_id).filter(Boolean),
    ...(logs || []).map((l) => l.calendar_event_id).filter(Boolean),
    ...(travel || []).map((t) => t.calendar_event_id).filter(Boolean),
  ]);
  if (gcalConfigured()) {
    const { events } = await fetchHorizonEvents(timeMin, timeMax);
    const split = splitMcAndBusy(events || [], ruleMap);
    mcEvents = split.mc || [];
    eventById = indexGcalEventsById([...(split.mc || []), ...(split.busy || [])]);
    const busy = (split.busy || []).filter((e) => !e?.id || !tied.has(e.id));
    busyBlocks = busyToBlocks(busy, []);
  }
  const dbBlocks = [
    ...tasksToBlocks(tasks || [], day),
    ...habitLogsToBlocks(logs || [], habitMap),
    ...travelToBlocks(travel || []),
    ...busyBlocks,
  ];
  const { blocks: baselined } = applyGcalBaselineTimes(dbBlocks, eventById);
  const blocks = [...baselined, ...untiedMcBlocks(mcEvents, tied)]
    .filter((b) => b.day === day && !b.synthetic);

  return { day, blocks, ruleMap, axis: { start_min: AXIS_START, end_min: AXIS_END } };
}

function matchClashBlock(blocks, eventId, titleHint) {
  if (eventId) {
    const byEvt = (blocks || []).find((b) => b.calendar_event_id === eventId);
    if (byEvt) return byEvt;
    const byId = (blocks || []).find((b) => String(b.id || '').includes(eventId));
    if (byId) return byId;
  }
  if (!titleHint) return null;
  const norm = (s) => String(s || '')
    .toLowerCase()
    .replace(/^mc\s*[^\w]*\s*/i, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  const want = norm(titleHint);
  if (!want) return null;
  let best = null;
  let bestScore = 0;
  for (const b of blocks || []) {
    const got = norm(b.title);
    if (!got) continue;
    let score = 0;
    if (got === want) score = 100;
    else if (got.includes(want) || want.includes(got)) score = 80;
    else {
      const aw = new Set(want.split(' ').filter((w) => w.length > 3));
      const bw = got.split(' ').filter((w) => w.length > 3);
      let hit = 0;
      for (const w of bw) if (aw.has(w)) hit += 1;
      if (aw.size) score = Math.round((hit / aw.size) * 70);
    }
    if (score > bestScore) {
      bestScore = score;
      best = b;
    }
  }
  return bestScore >= 40 ? best : null;
}

function countsTowardCap(b) {
  if (b.gcal_orphan && /decompress|buffer/i.test(b.title || '')) return false;
  const kind = String(b.kind || '');
  if (kind === 'travel' || kind === 'buffer' || kind === 'fixture' || kind === 'personal') return false;
  if (kind === 'workshop' || kind === 'lesson') return false;
  if (/^MC ⏳|Decompress/i.test(b.title || '')) return false;
  return kind === 'habit' || kind === 'mc_task' || !!b.habit_id || b.display_id != null;
}

function blockMinutes(b) {
  return Math.max(0, (b.end_min || 0) - (b.start_min || 0));
}

async function previewConflict(sb, pendingRow) {
  const ids = parseOverlapRelated(pendingRow.related_id);
  const day = ids?.day || String(pendingRow.target_date || '').slice(0, 10);
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return { ok: false, error: 'no_day', pending_id: pendingRow.id };
  }
  const snap = await loadDaySnapshot(sb, day);
  const isOverlap = /mc_vs_mc_overlap/i.test(pendingRow.reason || '')
    || /Move one of the overlapping/i.test(pendingRow.proposed_action || '');
  const isCap = /breach:cap:/.test(pendingRow.related_id || '')
    || /hard limit|over.*cap|MC work on/i.test(pendingRow.summary || '');

  const pair = String(pendingRow.summary || '').match(
    /Rule breach:\s*(.+?)\s+overlaps\s+(.+?)(?:\s+by\s+\d+m)?(?:\s+on\s+\d{4}-\d{2}-\d{2})?$/i,
  );
  const titleA = pair?.[1]?.trim() || null;
  const titleB = pair?.[2]?.trim() || null;
  const blockA = isOverlap ? matchClashBlock(snap.blocks, ids?.idA, titleA) : null;
  const blockB = isOverlap ? matchClashBlock(snap.blocks, ids?.idB, titleB) : null;

  const painted = snap.blocks.map((b) => {
    let hl = null;
    if (blockA && b.id === blockA.id) hl = 'a';
    else if (blockB && b.id === blockB.id) hl = 'b';
    else if (isCap && countsTowardCap(b)) hl = 'load';
    const slim = slimBlock(b, hl);
    slim.duration_min = blockMinutes(b);
    slim.counts_toward_cap = countsTowardCap(b);
    return slim;
  });

  const loadBlocks = painted.filter((b) => b.counts_toward_cap);
  const loadMin = loadBlocks.reduce((n, b) => n + b.duration_min, 0);
  const capMin = Number(snap.ruleMap.daily_task_cap_min || 240)
    + Number(snap.ruleMap.daily_task_cap_tolerance_min || 30);

  return {
    ok: true,
    pending_id: pendingRow.id,
    kind: isOverlap ? 'overlap' : (isCap ? 'cap' : 'day'),
    day,
    axis: snap.axis,
    blocks: painted,
    load_min: loadMin,
    cap_min: capMin,
    over_min: Math.max(0, loadMin - capMin),
    load_blocks: loadBlocks
      .slice()
      .sort((a, b) => b.duration_min - a.duration_min),
    pair: isOverlap ? {
      a: blockA ? slimBlock(blockA, 'a') : { title: titleA, highlight: 'a', movable: false },
      b: blockB ? slimBlock(blockB, 'b') : { title: titleB, highlight: 'b', movable: false },
    } : null,
  };
}

async function lookupMoveTarget(sb, block) {
  if (block.task_id || (block.display_id != null && block.kind === 'mc_task')) {
    const q = block.task_id
      ? `tasks?id=eq.${block.task_id}&select=id,display_id,title,due_date,slot_pinned,scheduled_start,scheduled_end,calendar_event_id,priority`
      : `tasks?display_id=eq.${block.display_id}&select=id,display_id,title,due_date,slot_pinned,scheduled_start,scheduled_end,calendar_event_id,priority`;
    const rows = await sb(q);
    if (rows?.[0]) return { type: 'task', row: rows[0] };
  }
  if (block.habit_id) {
    const rows = await sb(
      `recurring_tasks?id=eq.${block.habit_id}&select=id,title,duration_min,ideal_time,priority`,
    );
    if (rows?.[0]) {
      return {
        type: 'habit',
        row: rows[0],
        ideal_date: block.ideal_date || block.day,
        calendar_event_id: block.calendar_event_id || null,
      };
    }
  }
  if (block.calendar_event_id) {
    const logs = await sb(
      `recurring_log?calendar_event_id=eq.${encodeURIComponent(block.calendar_event_id)}`
      + '&select=recurring_task_id,ideal_date,scheduled_date,calendar_event_id&order=at.desc&limit=1',
    );
    if (logs?.[0]) {
      const habits = await sb(
        `recurring_tasks?id=eq.${logs[0].recurring_task_id}&select=id,title,duration_min,ideal_time,priority`,
      );
      if (habits?.[0]) {
        return {
          type: 'habit',
          row: habits[0],
          ideal_date: logs[0].ideal_date || logs[0].scheduled_date,
          calendar_event_id: block.calendar_event_id,
        };
      }
    }
    const tasks = await sb(
      `tasks?calendar_event_id=eq.${encodeURIComponent(block.calendar_event_id)}`
      + '&select=id,display_id,title,due_date,slot_pinned,scheduled_start,scheduled_end,calendar_event_id,priority',
    );
    if (tasks?.[0]) return { type: 'task', row: tasks[0] };
  }
  return null;
}

function pickLower(a, b, targetA, targetB) {
  if (a?.movable && !b?.movable) return 'a';
  if (b?.movable && !a?.movable) return 'b';
  const pa = targetA?.row?.priority || a?.priority;
  const pb = targetB?.row?.priority || b?.priority;
  if (pa != null || pb != null) {
    return priorityRank(pa) >= priorityRank(pb) ? 'a' : 'b';
  }
  return 'b';
}

async function findSlot(sb, day, durationMin, title, excludeBlockId, ruleMap) {
  const travel = await sb('travel_blocks?select=*&block_type=in.(travel_out,travel_back)');
  const awaySpans = awaySpansFromTravelBlocks(travel || []);

  for (let step = 0; step < 14; step += 1) {
    const d = addDays(day, step);
    if (dayBlockedForPlacement(d, awaySpans)) continue;
    const snap = await loadDaySnapshot(sb, d);
    const peers = snap.blocks.filter((b) => b.id !== excludeBlockId);
    const busy = peers.map((b) => ({
      startMs: londonYmdHmToUtcMs(d, hmLabel(b.start_min)),
      endMs: londonYmdHmToUtcMs(d, hmLabel(b.end_min)),
      summary: b.title,
    }));
    const placed = peers.map((b) => ({
      day: d,
      startIso: new Date(londonYmdHmToUtcMs(d, hmLabel(b.start_min))).toISOString(),
      endIso: new Date(londonYmdHmToUtcMs(d, hmLabel(b.end_min))).toISOString(),
      title: b.title,
    }));
    const slot = trySlotOnDay(
      d, durationMin, '10:00', title, busy, placed, {}, ruleMap,
    );
    if (slot) return slot;
  }
  return null;
}

async function applyMove(sb, target, slot, actor) {
  if (target.type === 'task') {
    const task = target.row;
    await sb(`tasks?id=eq.${task.id}`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: {
        scheduled_start: slot.startIso,
        scheduled_end: slot.endIso,
        slot_pinned: true,
        slot_pinned_at: new Date().toISOString(),
        slot_pinned_from: task.scheduled_start || null,
        last_activity_at: new Date().toISOString(),
      },
    });
    const day = isoToLondonDate(slot.startIso);
    const action = [
      `MOVE GCal event for MC-${task.display_id} (${task.title})`,
      `to ${slot.startIso} – ${slot.endIso} (London).`,
      task.calendar_event_id ? `event_id=${task.calendar_event_id}` : 'CREATE if missing',
      'slot_pinned=true.',
    ].join(' ');
    await upsertPushRow(sb, {
      related_id: relatedIdForTask(task.id),
      entity_type: 'task',
      change_kind: 'move',
      summary: `Conflict resolve: MC-${task.display_id} → ${day}`,
      proposed_action: action,
      payload: {
        task_id: task.id,
        display_id: task.display_id,
        title: task.title,
        new_start: slot.startIso,
        new_end: slot.endIso,
        calendar_event_id: task.calendar_event_id || null,
      },
    });
    return { moved: 'task', display_id: task.display_id, day, start: slot.startIso, end: slot.endIso };
  }

  const habit = target.row;
  const ideal = target.ideal_date || slot.day;
  const pinChange = `diary_pin:${slot.startIso}|${slot.endIso}`;
  const projectionKey = `diary:${habit.id}:${ideal}`;
  await sb(`recurring_tasks?id=eq.${habit.id}`, {
    method: 'PATCH', prefer: 'return=minimal',
    body: { last_scheduled: slot.day },
  });
  const existing = await sb(
    `recurring_log?recurring_task_id=eq.${habit.id}&ideal_date=eq.${ideal}&select=id&order=at.desc&limit=3`,
  );
  const logBody = {
    change: pinChange,
    scheduled_date: slot.day,
    roll_reason: 'conflict_resolve',
    calendar_event_id: target.calendar_event_id || null,
    ideal_date: ideal,
    projection_key: projectionKey,
  };
  if (existing?.[0]?.id) {
    await sb(`recurring_log?id=eq.${existing[0].id}`, {
      method: 'PATCH', prefer: 'return=minimal', body: logBody,
    });
  } else {
    await sb('recurring_log', {
      method: 'POST', prefer: 'return=minimal',
      body: { recurring_task_id: habit.id, actor, ...logBody },
    });
  }
  const related = relatedIdForHabit(habit.id, ideal, target.calendar_event_id || null);
  await supersedeSiblingHabitRows(sb, {
    habitId: habit.id,
    keepRelatedId: related,
    calendarEventId: target.calendar_event_id || null,
    idealDate: ideal,
    scheduledDate: slot.day,
    actor,
  });
  const action = [
    `MOVE/CREATE habit "${habit.title}" block to ${slot.startIso} – ${slot.endIso}.`,
    target.calendar_event_id ? `event_id=${target.calendar_event_id}` : 'Create Primary event',
    `ideal_date=${ideal}; scheduled_date=${slot.day}.`,
  ].join(' ');
  await upsertPushRow(sb, {
    related_id: related,
    entity_type: 'habit',
    change_kind: 'move',
    summary: `Conflict resolve: ${habit.title} → ${slot.day}`,
    proposed_action: action,
    payload: {
      habit_id: habit.id,
      ideal_date: ideal,
      new_start: slot.startIso,
      new_end: slot.endIso,
      calendar_event_id: target.calendar_event_id || null,
    },
  });
  return { moved: 'habit', title: habit.title, day: slot.day, start: slot.startIso, end: slot.endIso };
}

/**
 * @param {'a'|'b'|'lower'} which
 */
async function resolveOverlap(sb, pendingRow, which, actor) {
  const preview = await previewConflict(sb, pendingRow);
  if (!preview.ok) {
    const err = new Error(preview.error || 'preview failed');
    err.status = 400;
    throw err;
  }
  if (!preview.pair) {
    const err = new Error('Not an overlap — pick a block from the list to move');
    err.status = 400;
    throw err;
  }
  const { pair, day } = preview;
  const targetA = pair.a?.movable ? await lookupMoveTarget(sb, pair.a) : null;
  const targetB = pair.b?.movable ? await lookupMoveTarget(sb, pair.b) : null;

  let side = which;
  if (side === 'lower') side = pickLower(pair.a, pair.b, targetA, targetB);
  const block = side === 'a' ? pair.a : pair.b;
  const target = side === 'a' ? targetA : targetB;
  if (!target || !block?.movable) {
    const err = new Error(
      'That block cannot be moved from here (travel / fixed / not linked to DB). Open Diary or pick the other block.',
    );
    err.status = 409;
    throw err;
  }

  const durationMin = Math.max(15, (block.end_min || 0) - (block.start_min || 0) || 60);
  const rules = await sb('scheduling_rules?select=key,value');
  const ruleMap = ruleMapFromRows(rules || []);
  const slot = await findSlot(sb, day, durationMin, block.title || 'block', block.id, ruleMap);
  if (!slot) {
    const err = new Error('No free legal slot in the next 14 days');
    err.status = 409;
    throw err;
  }

  const moved = await applyMove(sb, target, slot, actor);
  await sb(`pending_diary_changes?id=eq.${pendingRow.id}`, {
    method: 'PATCH', prefer: 'return=minimal',
    body: {
      status: 'applied',
      resolved_at: new Date().toISOString(),
      resolved_by: actor || 'conflict-resolver',
    },
  });
  return { ...moved, side, pending_id: pendingRow.id, preview_day: day };
}

/** Move one listed day block (cap / general) off the overloaded day. */
async function resolveDayBlock(sb, pendingRow, blockId, actor) {
  const preview = await previewConflict(sb, pendingRow);
  if (!preview.ok) {
    const err = new Error(preview.error || 'preview failed');
    err.status = 400;
    throw err;
  }
  const block = (preview.blocks || []).find((b) => b.id === blockId);
  if (!block) {
    const err = new Error('Block not found on that day');
    err.status = 404;
    throw err;
  }
  if (!block.movable) {
    const err = new Error('That block cannot be moved from here');
    err.status = 409;
    throw err;
  }
  const target = await lookupMoveTarget(sb, block);
  if (!target) {
    const err = new Error('Block is not linked to a habit/task in DB');
    err.status = 409;
    throw err;
  }
  const durationMin = Math.max(15, block.duration_min || 60);
  const rules = await sb('scheduling_rules?select=key,value');
  const ruleMap = ruleMapFromRows(rules || []);
  // Prefer next day onward so we actually reduce this day's load
  const slot = await findSlot(
    sb, addDays(preview.day, 1), durationMin, block.title || 'block', block.id, ruleMap,
  );
  if (!slot) {
    const err = new Error('No free legal slot in the next 14 days');
    err.status = 409;
    throw err;
  }
  const moved = await applyMove(sb, target, slot, actor);
  // Cap may need several moves — only mark applied when under cap after move
  const again = await previewConflict(sb, pendingRow);
  if (again.ok && again.kind === 'cap' && again.over_min > 0) {
    return {
      ...moved,
      pending_id: pendingRow.id,
      preview_day: preview.day,
      still_over: true,
      over_min: again.over_min,
      load_min: again.load_min,
      cap_min: again.cap_min,
    };
  }
  await sb(`pending_diary_changes?id=eq.${pendingRow.id}`, {
    method: 'PATCH', prefer: 'return=minimal',
    body: {
      status: 'applied',
      resolved_at: new Date().toISOString(),
      resolved_by: actor || 'conflict-resolver',
    },
  });
  return {
    ...moved,
    pending_id: pendingRow.id,
    preview_day: preview.day,
    still_over: false,
  };
}

module.exports = {
  parseOverlapRelated,
  loadDaySnapshot,
  previewConflict,
  resolveOverlap,
  resolveDayBlock,
  AXIS_START,
  AXIS_END,
};
