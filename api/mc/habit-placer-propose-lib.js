/**
 * Wire joint habit placer → pending_diary_changes (proposals only; no Calendar writes).
 */
const {
  ruleMapFromRows, bankHolidaySet, addDays, isoToLondonDate, isSchedulableDay,
} = require('./scheduling-rules-lib');
const {
  buildBusyIntervals, datedTasksToIntervals, findTaskBumps, findBlockedDayTaskBumps,
  findAwayIntervalTaskBumps, findAdminGapTaskBumps, findAfterHoursTaskBumps,
  findPastIncompleteTaskBumps, findSoftOverlapBumps,
  mergeTaskBumps, placeBumpedTasks,
  placeHabits, buildAmendments, provePlacement, awaySpansFromTravelBlocks,
  teachingDaySpansFromEvents, restDaySpansFromWorkshopEvents, restDaySpansFromDbRows,
  trySlotOnDay, dayBlockedForPlacement, dayBlockedForHabits,
} = require('./habit-placer-lib');
const { relatedIdForTask, relatedIdForHabit, upsertPushRow } = require('./gcal-push-lib');
const { idealsInHorizon } = require('./rrule-core');
const { computeMissedProposal } = require('./missed-habit-lib');
const { priorityRank } = require('./priority-lib');

function londonHm(iso) {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(iso));
  } catch (e) {
    return String(iso).slice(11, 16);
  }
}

function relatedId(habitId, idealDate) {
  return `habit_place:${habitId}:${idealDate}`;
}

/** Primary MC 🔁 habit events — must block placement; buildBusyIntervals strips them. */
function primaryRecurringGcalBusy(gcalEvents) {
  const out = [];
  for (const e of gcalEvents || []) {
    if ((e._calendarId || e.calendarId || 'primary') !== 'primary') continue;
    if (!e.start?.dateTime || e.status === 'cancelled') continue;
    const title = String(e.summary || '');
    if (!/^MC\s*🔁/u.test(title)) continue;
    const startMs = Date.parse(e.start.dateTime);
    const endMs = Date.parse(e.end?.dateTime || e.start.dateTime);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
    out.push({
      startMs,
      endMs,
      summary: title,
      calendar_event_id: e.id,
      is_mc_recurring_gcal: true,
    });
  }
  return out;
}

/**
 * Delete Primary MC 🔁 Google events not tied to a diary pin (duplicates / orphans).
 * Stale pinned events (wrong day) remain for MOVE via placer amendments.
 */
async function retireOrphanMcRecurringGcal(sb, gcalEvents, logs, fromYmd, toYmd) {
  const tied = new Set((logs || []).map((r) => r.calendar_event_id).filter(Boolean));
  let retired = 0;
  for (const e of gcalEvents || []) {
    if ((e._calendarId || e.calendarId || 'primary') !== 'primary') continue;
    if (!e.id || !e.start?.dateTime || e.status === 'cancelled') continue;
    if (!/^MC\s*🔁/u.test(String(e.summary || ''))) continue;
    const day = isoToLondonDate(e.start.dateTime);
    if (!day || day < fromYmd || day > toYmd) continue;
    if (tied.has(e.id)) continue;
    await upsertPushRow(sb, {
      related_id: `gcal:orphan_mc_recurring:${e.id}`,
      entity_type: 'habit',
      change_kind: 'skip',
      summary: `Retire orphan MC 🔁 ${e.summary} (${day})`,
      proposed_action: `DELETE Primary event ${e.id} (no diary pin — orphan/duplicate).`,
      payload: {
        calendar_event_id: e.id,
        title: e.summary,
        day,
        new_start: e.start.dateTime,
        new_end: e.end?.dateTime || e.start.dateTime,
      },
    });
    retired += 1;
  }
  // Exact twin Primary events (same title + start) — keep one, delete the rest.
  const groups = new Map();
  for (const e of gcalEvents || []) {
    if ((e._calendarId || e.calendarId || 'primary') !== 'primary') continue;
    if (!e.id || !e.start?.dateTime || e.status === 'cancelled') continue;
    if (!/^MC\s*🔁/u.test(String(e.summary || ''))) continue;
    const day = isoToLondonDate(e.start.dateTime);
    if (!day || day < fromYmd || day > toYmd) continue;
    const key = `${String(e.summary).trim()}|${Date.parse(e.start.dateTime)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => {
      const at = tied.has(a.id) ? 0 : 1;
      const bt = tied.has(b.id) ? 0 : 1;
      if (at !== bt) return at - bt;
      return String(a.id).localeCompare(String(b.id));
    });
    for (const e of list.slice(1)) {
      await upsertPushRow(sb, {
        related_id: `gcal:dup_mc_recurring:${e.id}`,
        entity_type: 'habit',
        change_kind: 'skip',
        summary: `Retire duplicate MC 🔁 ${e.summary}`,
        proposed_action: `DELETE Primary event ${e.id} (exact duplicate of another Primary block).`,
        payload: {
          calendar_event_id: e.id,
          title: e.summary,
          new_start: e.start.dateTime,
          new_end: e.end?.dateTime || e.start.dateTime,
        },
      });
      retired += 1;
    }
  }
  return { retired };
}

/** Existing keyed habit blocks — calendar event times only (live diary = truth). */
function parseDiaryPinTimes(change) {
  const m = String(change || '').match(/^diary_pin:([^|]+)\|([^|]+)/);
  if (!m) return null;
  const startIso = m[1].trim();
  const endIso = m[2].trim();
  if (!Number.isFinite(Date.parse(startIso)) || !Number.isFinite(Date.parse(endIso))) return null;
  return { startIso, endIso };
}

function loadExistingFromLog(logs, habits, gcalEvents) {
  const habitById = new Map((habits || []).map((h) => [h.id, h]));
  const byEvent = new Map();
  for (const e of gcalEvents || []) {
    if (e?.id) byEvent.set(e.id, e);
  }
  const best = new Map();
  for (const row of logs || []) {
    if (!row.ideal_date || !row.recurring_task_id) continue;
    const k = `${row.recurring_task_id}|${row.ideal_date}`;
    if (best.has(k)) continue;
    const habit = habitById.get(row.recurring_task_id);
    if (!habit) continue;
    const ev = row.calendar_event_id ? byEvent.get(row.calendar_event_id) : null;
    // Prefer live Google times; fall back to diary_pin so unflushed pins occupy busy.
    let startIso = null;
    let endIso = null;
    if (ev?.start?.dateTime && ev.status !== 'cancelled') {
      startIso = new Date(ev.start.dateTime).toISOString();
      endIso = new Date(ev.end?.dateTime || ev.start.dateTime).toISOString();
    } else {
      const pin = parseDiaryPinTimes(row.change);
      if (!pin) continue;
      startIso = pin.startIso;
      endIso = pin.endIso;
    }
    best.set(k, {
      habit_id: row.recurring_task_id,
      title: habit.title,
      ideal_date: row.ideal_date,
      startIso,
      endIso,
      calendar_event_id: (ev?.status === 'cancelled') ? null : (row.calendar_event_id || null),
    });
  }
  return [...best.values()];
}

/** Match Primary habit events missing from recurring_log (partial-apply orphans). */
function enrichExistingFromGcalTitles(existing, habits, gcalEvents, placements) {
  const byEvent = new Set((existing || []).map((e) => e.calendar_event_id).filter(Boolean));
  const byKey = new Map((existing || []).map((e) => [`${e.habit_id}|${e.ideal_date}`, e]));
  const habitsList = habits || [];
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

  for (const e of gcalEvents || []) {
    const cal = e._calendarId || e.calendarId || 'primary';
    if (cal !== 'primary') continue;
    if (!e.id || !e.start?.dateTime || byEvent.has(e.id)) continue;
    const summary = norm(e.summary);
    if (!summary || /^mc\s*[⚽🚗⏳⏰]/.test(summary)) continue;
    const habit = habitsList.find((h) => {
      const t = norm(h.title);
      return t && (summary === t || summary.includes(t));
    });
    if (!habit) continue;
    const day = isoToLondonDate(e.start.dateTime);
    const hit = (placements || []).find((p) => p.habit_id === habit.id && p.day === day);
    const ideal = hit?.ideal_date || day;
    const k = `${habit.id}|${ideal}`;
    if (byKey.has(k)) continue;
    byKey.set(k, {
      habit_id: habit.id,
      title: habit.title,
      ideal_date: ideal,
      startIso: new Date(e.start.dateTime).toISOString(),
      endIso: new Date(e.end?.dateTime || e.start.dateTime).toISOString(),
      calendar_event_id: e.id,
    });
    byEvent.add(e.id);
  }
  return [...byKey.values()];
}

function amendmentToPending(a) {
  if (!a || a.action === 'KEEP') return null;
  const day = isoToLondonDate(a.startIso) || a.ideal_date;
  const when = `${londonHm(a.startIso)}–${londonHm(a.endIso)}`;
  const tie = `recurring_task_id=${a.habit_id}; ideal_date=${a.ideal_date}`;
  const base = {
    change_type: 'habit_placement',
    target_date: day,
    urgency: a.action === 'DELETE' ? 'medium' : 'low',
    status: 'pending',
    related_id: relatedId(a.habit_id, a.ideal_date),
  };
  if (a.action === 'CREATE') {
    return {
      ...base,
      summary: `Place habit: ${a.title} — ${day} ${when}`,
      proposed_action: `CREATE Primary block "${a.title}" ${day} ${when}. ${tie}. Tie recurring_log.calendar_event_id after create.`,
      reason: 'Joint habit placer — no keyed calendar block for this occurrence',
    };
  }
  if (a.action === 'MOVE') {
    const fromDay = isoToLondonDate(a.from_startIso) || a.ideal_date;
    const fromWhen = `${londonHm(a.from_startIso)}–${londonHm(a.from_endIso)}`;
    return {
      ...base,
      summary: `Move habit: ${a.title} → ${day} ${when}`,
      proposed_action: `MOVE event ${a.calendar_event_id} to ${day} ${when} (was ${fromDay} ${fromWhen}). ${tie}.`,
      reason: 'Joint habit placer — existing block time/day differs from plan',
    };
  }
  if (a.action === 'DELETE') {
    return {
      ...base,
      summary: `Remove habit block: ${a.title} (${a.ideal_date})`,
      proposed_action: `DELETE Primary event ${a.calendar_event_id} (${day} ${when}). ${tie}.`,
      reason: 'Joint habit placer — occurrence dropped or superseded',
    };
  }
  return null;
}

function bumpToPending(b) {
  const bare = String(b.title || '').replace(/^MC-\d+\s*/, '');
  const why = b.reason === 'on_blocked_day'
    ? 'Task on rest/away day'
    : b.reason === 'past_slot_incomplete'
      ? 'Slot passed without Complete/Skip — roll to next free slot'
      : b.reason === 'task_overlap'
        ? 'Task overlaps another task'
        : 'Habits outrank dated tasks (unpinned)';
  if (b.unplaced || !b.new_start) {
    return {
      change_type: 'task_bump',
      target_date: b.habit_day,
      urgency: 'high',
      status: 'pending',
      related_id: `task_bump:MC-${b.display_id}:${b.habit_day}`,
      summary: `UNPLACED bump MC-${b.display_id}: no legal slot (${why})`,
      proposed_action: `FLAG MC-${b.display_id} ("${bare}") — cannot place within 14d under cap/window/gaps. ${why}.`,
      reason: 'Task bump UNPLACED — Cursor could not find a concrete slot',
    };
  }
  const day = b.new_day || isoToLondonDate(b.new_start);
  const when = `${londonHm(b.new_start)}–${londonHm(b.new_end)}`;
  return {
    change_type: 'task_bump',
    target_date: day,
    urgency: 'medium',
    status: 'pending',
    related_id: `task_bump:MC-${b.display_id}:${b.habit_day || day}`,
    summary: `Bump MC-${b.display_id} → ${day} ${when}`,
    proposed_action: `MOVE MC-${b.display_id} ("${bare}") to ${day} ${when} (was ${isoToLondonDate(b.task_start)} ${londonHm(b.task_start)}–${londonHm(b.task_end)}). ${why}. Update tasks.scheduled_start/end.`,
    reason: `${why}; concrete slot chosen by placer`,
  };
}

async function applyTaskBumpToDb(sb, bump) {
  if (!bump?.new_start || bump.unplaced) return false;
  const rows = await sb(
    `tasks?display_id=eq.${Number(bump.display_id)}&select=id,display_id,title,calendar_event_id,scheduled_start,scheduled_end`,
  );
  const task = rows?.[0];
  if (!task) return false;
  if (task.scheduled_start === bump.new_start && task.scheduled_end === bump.new_end) return true;
  await sb(`tasks?id=eq.${task.id}`, {
    method: 'PATCH',
    prefer: 'return=minimal',
    body: {
      scheduled_start: bump.new_start,
      scheduled_end: bump.new_end,
      last_activity_at: new Date().toISOString(),
    },
  });
  await upsertPushRow(sb, {
    related_id: relatedIdForTask(task.id),
    entity_type: 'task',
    change_kind: 'move',
    summary: `Scheduler bump MC-${task.display_id} → ${bump.new_day || isoToLondonDate(bump.new_start)}`,
    proposed_action: [
      `MOVE MC-${task.display_id} ("${task.title}") to ${bump.new_start}–${bump.new_end}.`,
      task.calendar_event_id ? `event_id=${task.calendar_event_id}` : 'create if missing',
      `Reason: ${bump.reason || 'task_bump'}.`,
    ].join(' '),
    payload: {
      task_id: task.id,
      display_id: task.display_id,
      new_start: bump.new_start,
      new_end: bump.new_end,
      from_start: bump.task_start || null,
      reason: bump.reason || 'task_bump',
      calendar_event_id: task.calendar_event_id || null,
    },
  });
  return true;
}

/** Decision 1 — board-only tasks: clear diary dates + queue Google deletes. */
async function clearProjectTasksFromDiary(sb, taskRows) {
  let cleared = 0;
  for (const t of taskRows || []) {
    if (!t?.display_id) continue;
    const evtId = t.calendar_event_id || null;
    await sb(`tasks?display_id=eq.${Number(t.display_id)}`, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: {
        scheduled_start: null,
        scheduled_end: null,
        calendar_event_id: null,
        slot_pinned: false,
        last_activity_at: new Date().toISOString(),
      },
    });
    if (evtId) {
      await upsertPushRow(sb, {
        related_id: relatedIdForTask(t.id || `display:${t.display_id}`),
        entity_type: 'task',
        change_kind: 'skip',
        summary: `Decision 1 — unsched MC-${t.display_id} from diary`,
        proposed_action: `DELETE Primary event ${evtId} (project tasks stay on board only).`,
        payload: {
          task_id: t.id || null,
          display_id: t.display_id,
          calendar_event_id: evtId,
          action: 'delete_event',
          reason: 'auto_schedule_project_tasks=false',
        },
      }).catch(() => {});
    }
    cleared += 1;
  }
  return cleared;
}

/** Decision 4 — never silent vanish: pending alert + optional GCal warning. */
async function writeUnplacedHabitAlerts(sb, unplaced, {
  existingPending, inserted, writePending = true,
} = {}) {
  if (!writePending) return 0;
  let n = 0;
  for (const u of unplaced || []) {
    if (!u?.habit_id || !u?.ideal_date) continue;
    const related = `habit_unplaced:${u.habit_id}:${u.ideal_date}`;
    if (existingPending && await existingPending('habit_unplaced', related)) continue;
    const title = u.title || 'habit';
    const out = await sb('pending_diary_changes', {
      method: 'POST',
      body: {
        change_type: 'habit_unplaced',
        target_date: u.ideal_date,
        urgency: 'high',
        status: 'pending',
        related_id: related,
        summary: `UNSCHEDULED: ${title} (${u.ideal_date})`,
        proposed_action: [
          `No legal diary slot for "${title}" ideal ${u.ideal_date}.`,
          `Reason: ${u.reason || 'no_slot'}.`,
          'Do not assume done — place manually or Skip this occurrence.',
        ].join(' '),
        reason: 'Decision 4 — never silent vanish',
      },
    });
    const id = Array.isArray(out) ? out[0]?.id : out?.id;
    if (id && inserted) inserted.push(id);
    if (id) n += 1;
    // Timed 15m warning on the ideal day so Primary still shows the hole.
    const warnStart = `${u.ideal_date}T19:00:00.000Z`;
    const warnEnd = `${u.ideal_date}T19:15:00.000Z`;
    await upsertPushRow(sb, {
      related_id: related,
      entity_type: 'other',
      change_kind: 'move',
      summary: `MC ⚠️ UNSCHEDULED: ${title}`,
      proposed_action: `CREATE Primary warning "MC ⚠️ UNSCHEDULED: ${title}" ${u.ideal_date} 20:00–20:15.`,
      payload: {
        title: `MC ⚠️ UNSCHEDULED: ${title}`,
        ideal_date: u.ideal_date,
        new_start: warnStart,
        new_end: warnEnd,
        reason: u.reason || 'no_slot',
      },
    }).catch(() => {});
  }
  return n;
}

/** Apply placer MOVE/CREATE/DELETE/KEEP(pin-sync) to recurring_log + gcal_push_queue. */
async function applyHabitAmendmentToDb(sb, a) {
  if (!a || !a.habit_id || !a.ideal_date) return false;
  const logRows = await sb(
    `recurring_log?recurring_task_id=eq.${a.habit_id}&ideal_date=eq.${a.ideal_date}`
    + '&select=id,calendar_event_id,scheduled_date,change&order=at.desc&limit=1',
  );
  const keepId = logRows?.[0]?.id || null;
  // CREATE must never reuse a stale calendar_event_id — that queues a patch on a
  // deleted Primary event and leaves a Diary ghost forever.
  const evtId = a.action === 'CREATE'
    ? null
    : (a.calendar_event_id || logRows?.[0]?.calendar_event_id || null);
  const log = logRows?.[0] || null;

  // CREATE after a dead link: drop the corpse so flush inserts cleanly.
  if (a.action === 'CREATE' && logRows?.[0]?.calendar_event_id) {
    const stale = logRows[0].calendar_event_id;
    await upsertPushRow(sb, {
      related_id: relatedIdForHabit(a.habit_id, a.ideal_date, stale),
      entity_type: 'habit',
      change_kind: 'skip',
      summary: `Placer CREATE supersedes stale event: ${a.title}`,
      proposed_action: `DELETE Primary event ${stale} (stale before recreate).`,
      payload: {
        habit_id: a.habit_id,
        title: a.title,
        ideal_date: a.ideal_date,
        calendar_event_id: stale,
        action: 'delete_event',
      },
    }).catch(() => {});
  }

  // KEEP: Google may already match plan while recurring_log pin/scheduled_date is stale.
  if (a.action === 'KEEP') {
    if (!a.startIso || !a.endIso || !keepId) return false;
    const day = isoToLondonDate(a.startIso) || a.ideal_date;
    const pinChange = `diary_pin:${a.startIso}|${a.endIso}`;
    if (log?.scheduled_date === day && log?.change === pinChange && log?.calendar_event_id === evtId) {
      return false;
    }
    await sb(`recurring_log?id=eq.${keepId}`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: {
        change: pinChange,
        scheduled_date: day,
        roll_reason: 'habit_placer_keep_sync',
        calendar_event_id: evtId,
        ideal_date: a.ideal_date,
        projection_key: `placer:${a.habit_id}:${a.ideal_date}`,
      },
    });
    return true;
  }

  // Unplaced / dropped: never leave a dated scheduled_date (esp. on rest/away).
  // Queue Google delete BEFORE clearing calendar_event_id so the id is never lost.
  if (a.action === 'DELETE') {
    if (evtId) {
      await upsertPushRow(sb, {
        related_id: relatedIdForHabit(a.habit_id, a.ideal_date, evtId),
        entity_type: 'habit',
        change_kind: 'skip',
        summary: `Placer unplace: ${a.title} (${a.ideal_date})`,
        proposed_action: [
          `DELETE Primary event ${evtId} for habit "${a.title}".`,
          `ideal_date=${a.ideal_date}; scheduled_date=null (no legal slot / blocked day).`,
        ].join(' '),
        payload: {
          habit_id: a.habit_id,
          title: a.title,
          ideal_date: a.ideal_date,
          calendar_event_id: evtId,
          action: 'delete_event',
        },
      });
    }
    if (keepId) {
      await sb(`recurring_log?id=eq.${keepId}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: {
          change: `unplaced ${a.ideal_date}|habit_placer`,
          scheduled_date: null,
          roll_reason: 'habit_placer_unplace',
          calendar_event_id: null,
          ideal_date: a.ideal_date,
          projection_key: `placer:${a.habit_id}:${a.ideal_date}`,
        },
      });
    }
    await sb(`recurring_tasks?id=eq.${a.habit_id}`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: {
        scheduled_note: `${a.ideal_date} · NOT in diary`,
        last_scheduled: null,
        updated_at: new Date().toISOString(),
      },
    }).catch(() => {});
    return true;
  }

  if (a.action !== 'MOVE' && a.action !== 'CREATE') return false;
  if (!a.startIso || !a.endIso) return false;
  const pinChange = `diary_pin:${a.startIso}|${a.endIso}`;
  const day = isoToLondonDate(a.startIso) || a.ideal_date;
  const logBody = {
    change: pinChange,
    scheduled_date: day,
    roll_reason: 'habit_placer_enforce',
    calendar_event_id: evtId,
    ideal_date: a.ideal_date,
    projection_key: `placer:${a.habit_id}:${a.ideal_date}`,
  };
  if (keepId) {
    await sb(`recurring_log?id=eq.${keepId}`, {
      method: 'PATCH', prefer: 'return=minimal', body: logBody,
    });
  } else {
    await sb('recurring_log', {
      method: 'POST', prefer: 'return=minimal',
      body: { recurring_task_id: a.habit_id, actor: 'cursor', ...logBody },
    });
  }
  // Pin means this ideal is no longer missed — clear sticky missed_habit backlog.
  await sb(
    `pending_diary_changes?change_type=eq.missed_habit&related_id=eq.${encodeURIComponent(`habit:${a.habit_id}:${a.ideal_date}`)}&status=eq.pending`,
    {
      method: 'PATCH', prefer: 'return=minimal',
      body: {
        status: 'applied',
        resolved_at: new Date().toISOString(),
        resolved_by: 'habit_placer_pin',
        proposed_action: `AUTO-RESOLVED — diary_pin ${day}`,
      },
    },
  ).catch(() => {});
  await upsertPushRow(sb, {
    related_id: relatedIdForHabit(a.habit_id, a.ideal_date, evtId),
    entity_type: 'habit',
    change_kind: 'move',
    summary: `Placer ${a.action}: ${a.title} → ${day}`,
    proposed_action: [
      `MOVE/CREATE habit "${a.title}" block to ${a.startIso} – ${a.endIso}.`,
      evtId ? `event_id=${evtId}` : 'Create Primary event',
      `ideal_date=${a.ideal_date}; scheduled_date=${day}.`,
    ].join(' '),
    payload: {
      habit_id: a.habit_id,
      title: a.title,
      ideal_date: a.ideal_date,
      new_start: a.startIso,
      new_end: a.endIso,
      calendar_event_id: evtId,
    },
  });
  const hm = String(a.startIso || '').includes('T')
    ? new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(a.startIso))
    : '';
  await sb(`recurring_tasks?id=eq.${a.habit_id}`, {
    method: 'PATCH', prefer: 'return=minimal',
    body: {
      scheduled_note: `${day}${hm ? ` ${hm}` : ''} (diary pin)`,
      last_scheduled: day,
      updated_at: new Date().toISOString(),
    },
  }).catch(() => {});
  return true;
}

/**
 * Belt-and-suspenders: any habit still dated on rest/away/teaching must MOVE to
 * placement day or be unplaced (scheduled_date null). Blocked day is never valid.
 */
async function clearHabitsDatedOnBlockedDays(sb, blockedSpans, fromYmd, toYmd, placements) {
  const placeByKey = new Map(
    (placements || []).map((p) => [`${p.habit_id}|${p.ideal_date}`, p]),
  );
  const logs = await sb(
    `recurring_log?scheduled_date=gte.${fromYmd}&scheduled_date=lte.${toYmd}`
    + '&select=id,recurring_task_id,ideal_date,scheduled_date,calendar_event_id,at'
    + '&order=at.desc&limit=5000',
  );
  const seen = new Set();
  const cleared = [];
  for (const row of logs || []) {
    if (!row?.recurring_task_id || !row.scheduled_date) continue;
    const ideal = row.ideal_date || String(row.scheduled_date).slice(0, 10);
    const k = `${row.recurring_task_id}|${ideal}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const day = String(row.scheduled_date).slice(0, 10);
    if (!dayBlockedForHabits(day, blockedSpans)) continue;
    const p = placeByKey.get(k);
    try {
      if (p?.startIso && p?.endIso && p.day && !dayBlockedForHabits(p.day, blockedSpans)) {
        const ok = await applyHabitAmendmentToDb(sb, {
          action: 'MOVE',
          habit_id: row.recurring_task_id,
          title: p.title || 'habit',
          ideal_date: ideal,
          startIso: p.startIso,
          endIso: p.endIso,
          calendar_event_id: row.calendar_event_id || null,
          from_startIso: null,
        });
        if (ok) cleared.push({ title: p.title, from: day, to: p.day, action: 'MOVE' });
        continue;
      }
      const ok = await applyHabitAmendmentToDb(sb, {
        action: 'DELETE',
        habit_id: row.recurring_task_id,
        title: p?.title || 'habit',
        ideal_date: ideal,
        startIso: null,
        endIso: null,
        calendar_event_id: row.calendar_event_id || null,
      });
      if (ok) cleared.push({ title: p?.title || ideal, from: day, to: null, action: 'UNPLACE' });
    } catch (e) {
      cleared.push({
        title: p?.title || ideal, from: day, to: null, action: 'ERROR', error: e.message,
      });
    }
  }
  return cleared;
}

/** Past habit ideals with no Complete/Skip → concrete next-slot pin + GCal queue. */
async function applyIncompleteHabitRolls(ctx) {
  const {
    sb, habits, ruleMap, holidays, hardBusy, placements, dayUsed, fromYmd, awaySpans,
    existingPending, inserted, writePending = true,
  } = ctx;
  const today = fromYmd;
  const lookback = addDays(today, -21);
  let rolled = 0;
  const busyWork = (hardBusy || []).slice();
  for (const p of placements || []) {
    busyWork.push({
      startMs: Date.parse(p.startIso),
      endMs: Date.parse(p.endIso),
      summary: p.title,
    });
  }
  const used = { ...(dayUsed || {}) };
  const maxRolls = Number(ruleMap.missed_habit_max_rolls || ruleMap.max_habit_rolls || 3);

  for (const habit of habits || []) {
    const ideals = idealsInHorizon(habit.rrule, lookback, addDays(today, -1), 40, today);
    for (const ideal of ideals) {
      if (habit.last_done && String(habit.last_done) >= String(ideal)) continue;
      const skipRows = await sb(
        `recurring_log?recurring_task_id=eq.${habit.id}&ideal_date=eq.${ideal}`
        + `&change=like.${encodeURIComponent('skipped%')}&limit=1`,
      );
      if (skipRows?.[0]) continue;
      const doneRows = await sb(
        `recurring_log?recurring_task_id=eq.${habit.id}&ideal_date=eq.${ideal}`
        + `&change=like.${encodeURIComponent('completed%')}&limit=1`,
      );
      if (doneRows?.[0]) continue;

      // Load pin first: still-future slots stay; past incomplete pins re-roll.
      const logRows = await sb(
        `recurring_log?recurring_task_id=eq.${habit.id}&ideal_date=eq.${ideal}`
        + '&select=id,calendar_event_id,scheduled_date,change&order=at.desc&limit=1',
      );
      const existingSched = logRows?.[0]?.scheduled_date
        ? String(logRows[0].scheduled_date).slice(0, 10)
        : null;
      if (existingSched && existingSched >= today) continue;

      const prop = computeMissedProposal({
        habit, lastDue: ideal, today, ruleMap, holidays, maxRolls,
      });
      // Only time-critical/anchor unplaceable blocks auto-roll. Cap messages
      // ("wait for next occurrence") must NOT leave a dead incomplete pin.
      if (/UNPLACEABLE/i.test(prop.proposed || '')) {
        if (writePending && existingPending) {
          const relatedId = `habit:${habit.id}:${ideal}`;
          if (!(await existingPending('missed_habit', relatedId))) {
            const out = await sb('pending_diary_changes', {
              method: 'POST',
              body: {
                change_type: 'missed_habit',
                target_date: ideal,
                summary: `Missed habit: ${habit.title}`,
                proposed_action: prop.proposed,
                reason: prop.reason,
                urgency: prop.urgency || 'high',
                status: 'pending',
                related_id: relatedId,
              },
            });
            const id = Array.isArray(out) ? out[0]?.id : out?.id;
            if (id && inserted) inserted.push(id);
          }
        }
        continue;
      }

      let slot = null;
      for (let pass = 0; pass < 2 && !slot; pass += 1) {
        const slotOpts = pass === 0 ? {} : { allowEvening: true };
        for (let i = 0; i < 14; i += 1) {
          const day = addDays(today, i);
          if (!isSchedulableDay(day, ruleMap, holidays)) continue;
          if (dayBlockedForHabits(day, awaySpans || [])) continue;
          const trial = trySlotOnDay(
            day, Number(habit.duration_min) || 60, habit.ideal_time || '09:00',
            habit.title, busyWork, placements || [], used, ruleMap, slotOpts,
          );
          if (trial) { slot = trial; break; }
        }
      }
      if (!slot) continue;

      const pinChange = `diary_pin:${slot.startIso}|${slot.endIso}`;
      const keepId = logRows?.[0]?.id || null;
      const evtId = logRows?.[0]?.calendar_event_id || null;
      const logBody = {
        change: pinChange,
        scheduled_date: slot.day,
        roll_reason: 'incomplete_auto_roll',
        calendar_event_id: evtId,
        ideal_date: ideal,
        projection_key: `auto-roll:${habit.id}:${ideal}`,
      };
      if (keepId) {
        await sb(`recurring_log?id=eq.${keepId}`, {
          method: 'PATCH', prefer: 'return=minimal', body: logBody,
        });
      } else {
        await sb('recurring_log', {
          method: 'POST', prefer: 'return=minimal',
          body: { recurring_task_id: habit.id, actor: 'cursor', ...logBody },
        });
      }
      await sb(`recurring_tasks?id=eq.${habit.id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: {
          last_scheduled: slot.day,
          scheduled_note: `${slot.day} auto-roll (incomplete ${ideal})`,
          updated_at: new Date().toISOString(),
        },
      });
      await upsertPushRow(sb, {
        related_id: relatedIdForHabit(habit.id, ideal, evtId),
        entity_type: 'habit',
        change_kind: 'move',
        summary: `Auto-roll habit ${habit.title} → ${slot.day}`,
        proposed_action: [
          `MOVE/CREATE habit "${habit.title}" block to ${slot.startIso} – ${slot.endIso}.`,
          evtId ? `event_id=${evtId}` : 'Create Primary event then PATCH recurring_log.calendar_event_id',
          `ideal_date=${ideal}; scheduled_date=${slot.day}. Incomplete slot — not Complete/Skip.`,
        ].join(' '),
        payload: {
          habit_id: habit.id,
          title: habit.title,
          ideal_date: ideal,
          new_start: slot.startIso,
          new_end: slot.endIso,
          calendar_event_id: evtId,
        },
      });
      // Resolve any pending missed_habit for this ideal
      await sb(
        `pending_diary_changes?change_type=eq.missed_habit&related_id=eq.${encodeURIComponent(`habit:${habit.id}:${ideal}`)}&status=eq.pending`,
        {
          method: 'PATCH', prefer: 'return=minimal',
          body: {
            status: 'applied',
            resolved_at: new Date().toISOString(),
            resolved_by: 'incomplete_auto_roll',
            proposed_action: `AUTO-APPLIED → ${slot.day} ${londonHm(slot.startIso)}–${londonHm(slot.endIso)}`,
          },
        },
      );
      used[slot.day] = (used[slot.day] || 0) + slot.durationMin;
      busyWork.push({
        startMs: Date.parse(slot.startIso),
        endMs: Date.parse(slot.endIso),
        summary: habit.title,
      });
      rolled += 1;
    }
  }
  return { rolled };
}

/**
 * Pins that already sit on top of hard busy (personal timed, workshops,
 * other habits) re-find the next free slot. Uses the same busy map as placers —
 * Primary personal Busy must already be in hardBusy after isMcBlock fix.
 */
async function rehomePinsOverHardBusy(ctx) {
  const {
    sb, habits, ruleMap, holidays, hardBusy, placements, dayUsed, fromYmd, awaySpans,
    gcalEvents,
  } = ctx;
  const today = fromYmd;
  const horizon = addDays(today, 21);
  let rehomed = 0;
  const busyWork = (hardBusy || []).slice();
  for (const p of placements || []) {
    busyWork.push({
      startMs: Date.parse(p.startIso),
      endMs: Date.parse(p.endIso),
      summary: p.title,
      habit_id: p.habit_id,
      ideal_date: p.ideal_date,
    });
  }
  const used = { ...(dayUsed || {}) };
  const byEvt = new Map();
  for (const e of gcalEvents || []) {
    if (e?.id) byEvt.set(e.id, e);
  }

  for (const habit of habits || []) {
    const rows = await sb(
      `recurring_log?recurring_task_id=eq.${habit.id}`
      + `&scheduled_date=gte.${today}&scheduled_date=lte.${horizon}`
      + `&change=like.${encodeURIComponent('diary_pin%')}`
      + '&select=id,calendar_event_id,scheduled_date,change,ideal_date&order=at.desc&limit=40',
    );
    const seenIdeal = new Set();
    for (const row of rows || []) {
      const ideal = String(row.ideal_date || row.scheduled_date || '');
      if (!ideal || seenIdeal.has(ideal)) continue;
      seenIdeal.add(ideal);
      if (habit.last_done && String(habit.last_done) >= ideal) continue;
      let startMs = null;
      let endMs = null;
      const ev = row.calendar_event_id ? byEvt.get(row.calendar_event_id) : null;
      if (ev?.start?.dateTime && ev.status !== 'cancelled') {
        startMs = Date.parse(ev.start.dateTime);
        endMs = Date.parse(ev.end?.dateTime || ev.start.dateTime);
      } else {
        const pin = parseDiaryPinTimes(row.change);
        if (!pin) continue;
        startMs = Date.parse(pin.startIso);
        endMs = Date.parse(pin.endIso);
      }
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;

      const busySansSelf = busyWork.filter((b) => {
        if (b.habit_id === habit.id && String(b.ideal_date || '') === ideal) return false;
        if (row.calendar_event_id && b.calendar_event_id === row.calendar_event_id) return false;
        return true;
      });
      const clashes = busySansSelf.some(
        (b) => Number.isFinite(b.startMs) && Number.isFinite(b.endMs)
          && startMs < b.endMs && b.startMs < endMs,
      );
      if (!clashes) continue;

      let slot = null;
      for (let pass = 0; pass < 2 && !slot; pass += 1) {
        const slotOpts = pass === 0 ? {} : { allowEvening: true };
        for (let i = 0; i < 21; i += 1) {
          const day = addDays(today, i);
          if (!isSchedulableDay(day, ruleMap, holidays)) continue;
          if (dayBlockedForHabits(day, awaySpans || [])) continue;
          const trial = trySlotOnDay(
            day, Number(habit.duration_min) || 60, habit.ideal_time || '09:00',
            habit.title, busySansSelf, placements || [], used, ruleMap, slotOpts,
          );
          if (trial) { slot = trial; break; }
        }
      }
      if (!slot) continue;
      // Already at this free slot (wrong duplicate GCal only) — skip rewrite.
      if (slot.startIso === new Date(startMs).toISOString()
        && slot.endIso === new Date(endMs).toISOString()) {
        continue;
      }

      const pinChange = `diary_pin:${slot.startIso}|${slot.endIso}`;
      const evtId = row.calendar_event_id || null;
      await sb(`recurring_log?id=eq.${row.id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: {
          change: pinChange,
          scheduled_date: slot.day,
          roll_reason: 'rehome_over_hard_busy',
          calendar_event_id: evtId,
          ideal_date: ideal,
          projection_key: `rehome:${habit.id}:${ideal}`,
        },
      });
      await sb(`recurring_tasks?id=eq.${habit.id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: {
          last_scheduled: slot.day,
          scheduled_note: `${slot.day} rehome (off busy ${ideal})`,
          updated_at: new Date().toISOString(),
        },
      });
      await upsertPushRow(sb, {
        related_id: relatedIdForHabit(habit.id, ideal, evtId),
        entity_type: 'habit',
        change_kind: 'move',
        summary: `Rehome habit ${habit.title} → ${slot.day} (off hard busy)`,
        proposed_action: [
          `MOVE/CREATE habit "${habit.title}" block to ${slot.startIso} – ${slot.endIso}.`,
          evtId ? `event_id=${evtId}` : 'Create Primary event then PATCH recurring_log.calendar_event_id',
          `ideal_date=${ideal}; cleared personal/client hard-busy clash.`,
        ].join(' '),
        payload: {
          habit_id: habit.id,
          title: habit.title,
          ideal_date: ideal,
          new_start: slot.startIso,
          new_end: slot.endIso,
          calendar_event_id: evtId,
        },
      });
      for (let bi = busyWork.length - 1; bi >= 0; bi -= 1) {
        const b = busyWork[bi];
        if (b.habit_id === habit.id && String(b.ideal_date || '') === ideal) {
          busyWork.splice(bi, 1);
          continue;
        }
        if (b.startMs === startMs && b.endMs === endMs) busyWork.splice(bi, 1);
      }
      used[slot.day] = (used[slot.day] || 0) + slot.durationMin;
      busyWork.push({
        startMs: Date.parse(slot.startIso),
        endMs: Date.parse(slot.endIso),
        summary: habit.title,
        habit_id: habit.id,
        ideal_date: ideal,
      });
      rehomed += 1;
    }
  }
  return { rehomed };
}

/**
 * Run placer + amendments; optionally insert pending rows (idempotent on related_id).
 * @returns summary for notes / spike JSON
 */
async function runHabitPlacerPropose(ctx) {
  const {
    sb, ruleMap, holidays, fromYmd, toYmd, gcalEvents,
    existingPending, inserted, writePending = true,
    phaseAnchorYmd = null,
  } = ctx;

  const [habits, deps, logs, taskRows, travelBlocks, restDb] = await Promise.all([
    sb('recurring_tasks?select=id,title,priority,duration_min,ideal_time,window_days,time_critical,rrule,last_done,rolls_used&active=eq.true'),
    sb('recurring_task_deps?select=habit_id,depends_on_habit_id,dep_type,within_hours'),
    sb(
      'recurring_log?select=recurring_task_id,ideal_date,scheduled_date,calendar_event_id,change'
      + `&or=(and(scheduled_date.gte.${fromYmd},scheduled_date.lte.${toYmd}),and(ideal_date.gte.${fromYmd},ideal_date.lte.${toYmd}))`
      + '&order=at.desc&limit=8000',
    ),
    sb(
      'tasks?select=id,display_id,title,state,priority,slot_pinned,scheduled_start,scheduled_end,calendar_event_id,'
      + 'depends_on:depends_on_task_id(display_id)'
      + '&scheduled_start=not.is.null'
      + `&scheduled_start=gte.${addDays(fromYmd, -21)}T00:00:00Z`
      + `&scheduled_start=lte.${toYmd}T23:59:59Z`
      + '&state=not.in.(done,verified,wont_do,superseded)',
    ),
    sb(
      'travel_blocks?select=block_type,starts_at,ends_at,venue_name,workshop_title,workshop_start,workshop_row_key'
      + '&block_type=in.(travel_out,travel_back)'
      + `&starts_at=gte.${fromYmd}T00:00:00Z`
      + `&starts_at=lte.${toYmd}T23:59:59Z`,
    ),
    sb(`rest_day_blocks?status=eq.active&rest_date=gte.${fromYmd}&rest_date=lte.${toYmd}&select=rest_date,workshop_title`),
  ]);

  const taskRowsNorm = (taskRows || []).map((t) => ({
    ...t,
    depends_on_display_id: t.depends_on?.display_id ?? t.depends_on_display_id ?? null,
  }));
  const autoScheduleTasks = String(ruleMap.auto_schedule_project_tasks || 'false') === 'true';
  const existingLog = loadExistingFromLog(logs || [], habits || [], gcalEvents || []);
  const clientBusy = buildBusyIntervals(gcalEvents || [], ruleMap);
  // Decision 1: project tasks stay on the board — do not fence or bump them.
  const pinnedBusy = autoScheduleTasks
    ? datedTasksToIntervals(taskRowsNorm, { pinnedOnly: true })
    : [];
  const softTasks = autoScheduleTasks
    ? datedTasksToIntervals(taskRowsNorm, { pinnedOnly: false })
    : [];
  const awaySpans = awaySpansFromTravelBlocks(travelBlocks || []);
  const teachingSpans = teachingDaySpansFromEvents(gcalEvents || [], ruleMap);
  const restSpans = restDaySpansFromWorkshopEvents(gcalEvents || [], ruleMap)
    .concat(restDaySpansFromDbRows(restDb || []));
  const blockedSpans = awaySpans.concat(teachingSpans).concat(restSpans);
  // Existing habit pins + live Primary MC 🔁 GCal blocks (striped from clientBusy).
  const existingHabitBusy = (existingLog || []).map((e) => ({
    startMs: Date.parse(e.startIso),
    endMs: Date.parse(e.endIso),
    summary: e.title,
    habit_id: e.habit_id,
    ideal_date: e.ideal_date,
    calendar_event_id: e.calendar_event_id || null,
  })).filter((b) => Number.isFinite(b.startMs) && Number.isFinite(b.endMs));
  const gcalMcBusy = primaryRecurringGcalBusy(gcalEvents || []);
  // Dedup GCal intervals already covered by pinned log event ids
  const knownEvt = new Set(existingHabitBusy.map((b) => b.calendar_event_id).filter(Boolean));
  const gcalMcExtra = gcalMcBusy.filter((b) => !b.calendar_event_id || !knownEvt.has(b.calendar_event_id));
  const eventIdByKey = new Map(
    (existingLog || [])
      .filter((e) => e.calendar_event_id)
      .map((e) => [`${e.habit_id}|${e.ideal_date}`, e.calendar_event_id]),
  );
  const hardBusy = clientBusy.concat(pinnedBusy).concat(blockedSpans)
    .concat(existingHabitBusy)
    .concat(gcalMcExtra)
    .sort((a, b) => a.startMs - b.startMs);

  const { placements, unplaced } = placeHabits(
    habits || [], deps || [], hardBusy.slice(), ruleMap, holidays, fromYmd, toYmd,
    {
      softTaskIntervals: softTasks,
      existingHabitIntervals: existingHabitBusy,
      phaseAnchorYmd: phaseAnchorYmd || fromYmd,
      eventIdByKey,
    },
  );
  const existing = enrichExistingFromGcalTitles(
    existingLog, habits || [], gcalEvents || [], placements,
  );
  let allBumps = [];
  let bumps = [];
  let bumpUnplaced = [];
  let sharedFlags = [];
  let taskDbApplied = 0;
  let tasksCleared = 0;
  if (autoScheduleTasks) {
    const bumpsRaw = mergeTaskBumps(
      findTaskBumps(placements, softTasks),
      findBlockedDayTaskBumps(softTasks, blockedSpans),
      findAwayIntervalTaskBumps(softTasks, awaySpans),
      findAdminGapTaskBumps(softTasks, ruleMap),
      findAfterHoursTaskBumps(softTasks, ruleMap),
      findPastIncompleteTaskBumps(softTasks, Date.now()),
      findSoftOverlapBumps(softTasks),
    );
    const placed = placeBumpedTasks(
      bumpsRaw, softTasks, hardBusy, placements, ruleMap, holidays, fromYmd,
    );
    bumps = placed.scheduled;
    bumpUnplaced = placed.unplaced;
    sharedFlags = placed.shared_calendar_flags;
    allBumps = bumps.concat(bumpUnplaced);
  } else if (writePending && (taskRowsNorm || []).length) {
    try {
      tasksCleared = await clearProjectTasksFromDiary(sb, taskRowsNorm);
    } catch (_) {
      tasksCleared = 0;
    }
  }
  const proof = provePlacement(placements, hardBusy, deps || [], ruleMap, {
    softTaskIntervals: softTasks,
    bumps: allBumps,
  });
  const amendments = buildAmendments(placements, existing, fromYmd);
  const counts = amendments.reduce((acc, a) => {
    acc[a.action] = (acc[a.action] || 0) + 1;
    return acc;
  }, {});
  const skippedPast = buildAmendments(placements, existing).length - amendments.length;

  let pendingWrote = 0;
  let habitDbApplied = 0;
  let habitRolls = { rolled: 0 };
  const proofOk = !!proof?.ok;
  // Never commit overlapping packs. Proof fail → proposals only (no pin/bump DB writes).
  if (writePending && proofOk) {
    for (const a of amendments) {
      // KEEP with no Google id → CREATE.
      // CREATE/MOVE always. DELETE only when the old slot is illegal (blocked day
      // or overlaps a same/higher-priority dated task). Skipping all DELETEs left
      // zombie GCal habits stacked on tasks after packing failed.
      const writeAction = (a.action === 'KEEP' && !a.calendar_event_id)
        ? { ...a, action: 'CREATE' }
        : a;
      let mayWrite = writeAction.action === 'MOVE'
        || writeAction.action === 'CREATE'
        || writeAction.action === 'KEEP';
      if (writeAction.action === 'DELETE') {
        // Always retire Google when plan dropped this ideal (wrong phase / culled).
        // Restricting to blocked/clash only left zombie wrong-phase pins on Primary.
        mayWrite = true;
      }
      if (mayWrite) {
        try {
          if (await applyHabitAmendmentToDb(sb, writeAction)) habitDbApplied += 1;
        } catch (_) { /* pending row still written below */ }
      }
      const row = amendmentToPending(a);
      if (!row) continue;
      if (existingPending && await existingPending(row.change_type, row.related_id)) continue;
      const applied = mayWrite && a.action !== 'KEEP';
      const out = await sb('pending_diary_changes', {
        method: 'POST',
        body: {
          ...row,
          status: applied ? 'applied' : (a.action === 'KEEP' ? 'applied' : row.status),
          resolved_at: (applied || a.action === 'KEEP') ? new Date().toISOString() : null,
          resolved_by: (applied || a.action === 'KEEP') ? 'habit_placer_enforce' : null,
        },
      });
      const id = Array.isArray(out) ? out[0]?.id : out?.id;
      if (id && inserted) inserted.push(id);
      if (id) pendingWrote += 1;
    }
    for (const b of allBumps) {
      // Diary is DB-master: apply concrete bumps immediately + queue GCal.
      if (!b.unplaced && b.new_start) {
        try {
          if (await applyTaskBumpToDb(sb, b)) taskDbApplied += 1;
        } catch (e) {
          /* keep pending row below so Alan still sees the intent */
        }
      }
      const row = bumpToPending(b);
      if (existingPending && await existingPending(row.change_type, row.related_id)) continue;
      const out = await sb('pending_diary_changes', {
        method: 'POST',
        body: {
          ...row,
          status: (!b.unplaced && b.new_start) ? 'applied' : row.status,
          resolved_at: (!b.unplaced && b.new_start) ? new Date().toISOString() : null,
          resolved_by: (!b.unplaced && b.new_start) ? 'habit_placer_auto' : null,
        },
      });
      const id = Array.isArray(out) ? out[0]?.id : out?.id;
      if (id && inserted) inserted.push(id);
      if (id) pendingWrote += 1;
    }
  } else if (writePending && !proofOk) {
    // Proof failed — surface intents as pending only; do not pin or bump into clashes.
    for (const a of amendments) {
      if (a.action === 'DELETE') {
        try {
          if (await applyHabitAmendmentToDb(sb, a)) habitDbApplied += 1;
        } catch (_) { /* ignore */ }
      }
      const row = amendmentToPending(a);
      if (!row) continue;
      if (existingPending && await existingPending(row.change_type, row.related_id)) continue;
      const out = await sb('pending_diary_changes', {
        method: 'POST',
        body: {
          ...row,
          summary: `[proof-blocked] ${row.summary || a.title || 'habit'}`,
          status: a.action === 'DELETE' ? 'applied' : 'pending',
          resolved_at: a.action === 'DELETE' ? new Date().toISOString() : null,
          resolved_by: a.action === 'DELETE' ? 'habit_placer_enforce' : null,
        },
      });
      const id = Array.isArray(out) ? out[0]?.id : out?.id;
      if (id && inserted) inserted.push(id);
      if (id) pendingWrote += 1;
    }
    for (const b of allBumps) {
      const row = bumpToPending(b);
      if (existingPending && await existingPending(row.change_type, row.related_id)) continue;
      const out = await sb('pending_diary_changes', {
        method: 'POST',
        body: {
          ...row,
          summary: `[proof-blocked] ${row.summary || `MC-${b.display_id}`}`,
          status: 'pending',
        },
      });
      const id = Array.isArray(out) ? out[0]?.id : out?.id;
      if (id && inserted) inserted.push(id);
      if (id) pendingWrote += 1;
    }
  }

  // Incomplete occurrences re-pin even when pack §5 proof fails — never leave
  // past incomplete diary blocks dropped on a finished day. Then re-home any
  // pins still sat on top of personal/client hard busy.
  if (writePending) {
    try {
      habitRolls = await applyIncompleteHabitRolls({
        sb,
        habits: habits || [],
        ruleMap,
        holidays,
        hardBusy,
        placements,
        fromYmd,
        awaySpans: blockedSpans,
        existingPending,
        inserted,
        writePending,
      });
    } catch (e) {
      habitRolls = { rolled: 0, error: e.message };
    }
    try {
      const rehome = await rehomePinsOverHardBusy({
        sb,
        habits: habits || [],
        ruleMap,
        holidays,
        hardBusy,
        placements,
        fromYmd,
        awaySpans: blockedSpans,
        gcalEvents: gcalEvents || [],
      });
      habitRolls = { ...habitRolls, ...rehome };
    } catch (e) {
      habitRolls = { ...habitRolls, rehomed: 0, rehome_error: e.message };
    }
    try {
      const orphans = await retireOrphanMcRecurringGcal(
        sb, gcalEvents || [], logs || [], fromYmd, toYmd,
      );
      habitRolls = { ...habitRolls, orphans_retired: orphans.retired };
    } catch (e) {
      habitRolls = { ...habitRolls, orphans_retired: 0, orphan_error: e.message };
    }
  }

  let blockedCleared = [];
  let unplacedAlerts = 0;
  if (writePending && proofOk) {
    try {
      blockedCleared = await clearHabitsDatedOnBlockedDays(
        sb, blockedSpans, fromYmd, toYmd, placements,
      );
      habitDbApplied += blockedCleared.length;
    } catch (e) {
      blockedCleared = [{ error: e.message }];
    }
  }
  if (writePending) {
    try {
      unplacedAlerts = await writeUnplacedHabitAlerts(sb, unplaced, {
        existingPending, inserted, writePending,
      });
      pendingWrote += unplacedAlerts;
    } catch (_) {
      unplacedAlerts = 0;
    }
  }

  return {
    placements,
    unplaced,
    amendments,
    amendment_counts: counts,
    existing_matched: existing.length,
    dated_tasks_seen: taskRowsNorm.length,
    pinned_busy: pinnedBusy.length,
    soft_tasks: softTasks.length,
    auto_schedule_project_tasks: autoScheduleTasks,
    tasks_cleared_from_diary: tasksCleared,
    away_spans: awaySpans.map((s) => ({
      startDay: s.startDay, endDay: s.endDay, restDay: s.restDay, summary: s.summary,
    })),
    away_span_count: awaySpans.length,
    rest_days: restSpans.map((s) => ({
      restDay: s.restDay, firstDay: s.firstDay, lastDay: s.lastDay,
      workshop_title: s.workshop_title, summary: s.summary,
    })),
    rest_day_count: restSpans.length,
    teaching_days: teachingSpans.map((s) => s.startDay),
    teaching_day_count: teachingSpans.length,
    task_bumps: allBumps,
    task_bump_count: allBumps.length,
    task_bump_scheduled: bumps.length,
    task_bump_unplaced: bumpUnplaced.length,
    task_db_applied: taskDbApplied,
    habit_db_applied: habitDbApplied,
    blocked_day_cleared: blockedCleared,
    habit_rolls: habitRolls,
    unplaced_alerts: unplacedAlerts,
    shared_calendar_flags: sharedFlags || [],
    skipped_past: skippedPast,
    proof,
    proof_ok: proofOk,
    proof_writes_blocked: writePending && !proofOk,
    pending_wrote: pendingWrote,
    calendar_writes: 0,
  };
}

module.exports = {
  relatedId,
  loadExistingFromLog,
  enrichExistingFromGcalTitles,
  amendmentToPending,
  bumpToPending,
  applyTaskBumpToDb,
  clearProjectTasksFromDiary,
  writeUnplacedHabitAlerts,
  applyHabitAmendmentToDb,
  clearHabitsDatedOnBlockedDays,
  applyIncompleteHabitRolls,
  rehomePinsOverHardBusy,
  runHabitPlacerPropose,
  ruleMapFromRows,
  bankHolidaySet,
  addDays,
};
