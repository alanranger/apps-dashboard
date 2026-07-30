/**
 * End-of-horizon pin ↔ Google Primary reconcile.
 * Full Horizon previously wrote diary_pins + push queue but never verified
 * every pin against live Primary — stale IDs became Diary ghosts / GCal dupes.
 */
const { fetchHorizonEvents, gcalConfigured } = require('./gcal-lib');
const { deletePrimaryEvent, getPrimaryEvent } = require('./gcal-write-lib');
const { relatedIdForHabit, upsertPushRow, supersedeSiblingHabitRows } = require('./gcal-push-lib');
const { londonToday, addDaysYmd } = require('./diary-lib');
const { isoToLondonDate, ruleMapFromRows } = require('./scheduling-rules-lib');
const { habitGcalTitle } = require('./gcal-title-lib');

function parsePin(change) {
  const m = String(change || '').match(/^diary_pin:([^|]+)\|([^|]+)/);
  if (!m) return null;
  const start = m[1].trim();
  const end = m[2].trim();
  if (!Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end))) return null;
  return { start, end };
}

function bareHabitTitle(summary, prefix) {
  let s = String(summary || '');
  if (prefix && s.startsWith(prefix)) s = s.slice(prefix.length);
  return s.replace(/^DONE\s*[·•\-–]\s*/i, '').trim().toLowerCase();
}

async function slotOccupied(sb, habitId, startIso, endIso, from, to) {
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return true;
  const logs = await sb(
    `recurring_log?select=recurring_task_id,change,calendar_event_id`
    + `&scheduled_date=gte.${from}&scheduled_date=lte.${to}&order=at.desc&limit=4000`,
  ) || [];
  const seen = new Set();
  for (const row of logs) {
    if (row.recurring_task_id === habitId) continue;
    const pin = parsePin(row.change);
    if (!pin) continue;
    const k = row.recurring_task_id;
    if (seen.has(k)) continue;
    seen.add(k);
    const a = Date.parse(pin.start);
    const b = Date.parse(pin.end);
    if (Number.isFinite(a) && Number.isFinite(b) && a < endMs && startMs < b) return true;
  }
  const tasks = await sb(
    `tasks?select=id,scheduled_start,scheduled_end`
    + `&scheduled_start=lt.${encodeURIComponent(endIso)}`
    + `&scheduled_end=gt.${encodeURIComponent(startIso)}`
    + '&state=not.in.(done,verified,wont_do,superseded)&limit=20',
  ) || [];
  return tasks.length > 0;
}

/**
 * Re-queue CREATE for pins whose calendar_event_id is dead or null.
 * Clears stale IDs so flush inserts instead of patching corpses.
 * When the event is alive but times drifted, pull live times into the pin
 * so Diary stops painting a different slot than Google.
 * Never recreate into a slot already occupied by another habit/task.
 */
async function healMissingPinEvents(sb, from, to, prefixes) {
  const logs = await sb(
    `recurring_log?select=id,recurring_task_id,ideal_date,scheduled_date,calendar_event_id,change`
    + `&scheduled_date=gte.${from}&scheduled_date=lte.${to}&order=at.desc`,
  ) || [];
  const habits = await sb('recurring_tasks?select=id,title,active&active=eq.true') || [];
  const habitMap = new Map(habits.map((h) => [h.id, h]));
  const seen = new Set();
  let missing_cleared = 0;
  let inserts_queued = 0;
  let pins_synced_from_gcal = 0;
  let pins_unplaced_clash = 0;

  for (const log of logs) {
    const pin = parsePin(log.change);
    if (!pin) continue;
    const key = `${log.recurring_task_id}|${log.ideal_date || log.scheduled_date}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const habit = habitMap.get(log.recurring_task_id);
    if (!habit) continue;

    if (log.calendar_event_id) {
      try {
        const live = await getPrimaryEvent(log.calendar_event_id);
        if (live && live.status !== 'cancelled') {
          const liveStart = live.start?.dateTime || live.start?.date;
          const liveEnd = live.end?.dateTime || live.end?.date;
          if (liveStart && liveEnd && String(liveStart).includes('T')) {
            const drift = Math.max(
              Math.abs(Date.parse(liveStart) - Date.parse(pin.start)),
              Math.abs(Date.parse(liveEnd) - Date.parse(pin.end)),
            ) / 60000;
            if (drift > 5) {
              const day = isoToLondonDate(liveStart) || log.scheduled_date;
              await sb(`recurring_log?calendar_event_id=eq.${encodeURIComponent(log.calendar_event_id)}`, {
                method: 'PATCH', prefer: 'return=minimal',
                body: {
                  change: `diary_pin:${liveStart}|${liveEnd}`,
                  scheduled_date: day,
                  roll_reason: 'pin_reconcile_from_gcal',
                },
              });
              pins_synced_from_gcal += 1;
            }
          }
          continue;
        }
      } catch (e) {
        if (!(e.status === 404 || e.status === 410)) continue;
      }
    }

    const staleId = log.calendar_event_id || null;
    if (staleId) {
      try { await deletePrimaryEvent(staleId); } catch (_) { /* already gone */ }
      await sb(`recurring_log?id=eq.${log.id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: { calendar_event_id: null },
      });
      missing_cleared += 1;
    }

    // Occupied slot → unplace rather than recreate a stacked conflict.
    if (await slotOccupied(sb, habit.id, pin.start, pin.end, from, to)) {
      await sb(`recurring_log?id=eq.${log.id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: {
          change: `unplaced ${log.ideal_date || log.scheduled_date}|reconcile_clash`,
          scheduled_date: null,
          calendar_event_id: null,
          roll_reason: 'pin_reconcile_clash',
        },
      });
      pins_unplaced_clash += 1;
      continue;
    }

    const related = relatedIdForHabit(habit.id, log.ideal_date || log.scheduled_date, null);
    await supersedeSiblingHabitRows(sb, {
      habitId: habit.id,
      keepRelatedId: related,
      calendarEventId: null,
      idealDate: log.ideal_date,
      scheduledDate: log.scheduled_date,
      actor: 'pin-reconcile',
    }).catch(() => {});
    await upsertPushRow(sb, {
      related_id: related,
      entity_type: 'habit',
      change_kind: 'move',
      summary: `Reconcile recreate: ${habit.title} → ${log.scheduled_date}`,
      proposed_action: `CREATE Primary for habit "${habit.title}" at ${pin.start} – ${pin.end} (stale/missing event).`,
      payload: {
        habit_id: habit.id,
        title: habitGcalTitle(habit.title, prefixes),
        ideal_date: log.ideal_date,
        scheduled_date: log.scheduled_date,
        new_start: pin.start,
        new_end: pin.end,
        calendar_event_id: null,
      },
    });
    inserts_queued += 1;
  }
  return { missing_cleared, inserts_queued, pins_synced_from_gcal, pins_unplaced_clash };
}

/**
 * One pin → one Primary event. Extra same-title same-day clones get deleted.
 */
async function purgeDuplicateHabitEvents(sb, from, to, prefixes) {
  if (!gcalConfigured()) return { dupes_deleted: 0 };
  const timeMin = `${from}T00:00:00.000Z`;
  const timeMax = `${addDaysYmd(to, 1)}T00:00:00.000Z`;
  const { events } = await fetchHorizonEvents(timeMin, timeMax);
  const primary = (events || []).filter(
    (e) => (e._calendarId || 'primary') === 'primary' && e.start?.dateTime && e.status !== 'cancelled',
  );
  const logs = await sb(
    `recurring_log?select=recurring_task_id,ideal_date,scheduled_date,calendar_event_id,change`
    + `&scheduled_date=gte.${from}&scheduled_date=lte.${to}&order=at.desc`,
  ) || [];
  const habits = await sb('recurring_tasks?select=id,title&active=eq.true') || [];
  const habitMap = new Map(habits.map((h) => [h.id, h]));
  const keepByDayTitle = new Map();
  const seen = new Set();
  for (const log of logs) {
    if (!parsePin(log.change) || !log.calendar_event_id) continue;
    const key = `${log.recurring_task_id}|${log.ideal_date || log.scheduled_date}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const habit = habitMap.get(log.recurring_task_id);
    if (!habit || !log.scheduled_date) continue;
    const bare = String(habit.title || '').trim().toLowerCase();
    keepByDayTitle.set(`${log.scheduled_date}|${bare}`, log.calendar_event_id);
  }

  let dupes_deleted = 0;
  const byDayTitle = new Map();
  for (const e of primary) {
    const day = isoToLondonDate(e.start.dateTime);
    const bare = bareHabitTitle(e.summary, prefixes.habit);
    if (!bare || /decompress|travel |away|rest|⚽|prep —/i.test(e.summary || '')) continue;
    if (!(e.summary || '').includes(prefixes.habit) && !/^P\d\s*·\s*MC-/i.test(e.summary || '')) {
      continue;
    }
    const k = `${day}|${bare}`;
    if (!byDayTitle.has(k)) byDayTitle.set(k, []);
    byDayTitle.get(k).push(e);
  }
  for (const [k, list] of byDayTitle) {
    if (list.length < 2) continue;
    const keepId = keepByDayTitle.get(k) || list[0].id;
    for (const e of list) {
      if (e.id === keepId) continue;
      try {
        await deletePrimaryEvent(e.id);
        dupes_deleted += 1;
      } catch (_) { /* ignore */ }
    }
  }
  return { dupes_deleted };
}

async function syncTaskTimesFromGcal(sb, from, to) {
  const timeMin = `${from}T00:00:00.000Z`;
  const timeMax = `${addDaysYmd(to, 1)}T00:00:00.000Z`;
  const tasks = await sb(
    `tasks?select=id,scheduled_start,scheduled_end,calendar_event_id`
    + `&scheduled_start=gte.${timeMin}&scheduled_start=lt.${timeMax}`
    + `&calendar_event_id=not.is.null`,
  ) || [];
  let tasks_synced = 0;
  for (const t of tasks) {
    try {
      const live = await getPrimaryEvent(t.calendar_event_id);
      if (!live || live.status === 'cancelled') continue;
      const liveStart = live.start?.dateTime;
      const liveEnd = live.end?.dateTime;
      if (!liveStart || !liveEnd) continue;
      const drift = Math.max(
        Math.abs(Date.parse(liveStart) - Date.parse(t.scheduled_start)),
        Math.abs(Date.parse(liveEnd) - Date.parse(t.scheduled_end)),
      ) / 60000;
      if (drift <= 5) continue;
      await sb(`tasks?id=eq.${t.id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: {
          scheduled_start: liveStart,
          scheduled_end: liveEnd,
          slot_pinned: true,
        },
      });
      tasks_synced += 1;
    } catch (_) { /* ignore */ }
  }
  return { tasks_synced };
}

async function collapseDuplicateIdealPins(sb, from, to) {
  const logs = await sb(
    `recurring_log?select=id,recurring_task_id,ideal_date,scheduled_date,calendar_event_id,change,at`
    + `&or=(and(scheduled_date.gte.${from},scheduled_date.lte.${to}),and(ideal_date.gte.${from},ideal_date.lte.${to}))`
    + `&order=at.desc`,
  ) || [];
  const best = new Map();
  let collapsed = 0;
  for (const log of logs) {
    if (!parsePin(log.change) || !log.ideal_date) continue;
    const key = `${log.recurring_task_id}|${log.ideal_date}`;
    if (!best.has(key)) {
      best.set(key, log);
      continue;
    }
    // Older pin for same ideal — retire so Diary/loadDbMasters cannot double-paint.
    await sb(`recurring_log?id=eq.${log.id}`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: {
        change: `superseded pin ${log.ideal_date}|reconcile`,
        scheduled_date: null,
        calendar_event_id: null,
        roll_reason: 'pin_reconcile_collapse',
      },
    });
    collapsed += 1;
  }
  return { pins_collapsed: collapsed };
}

async function runPinGcalReconcile(sb, {
  daysAhead = 200,
} = {}) {
  const from = londonToday();
  const to = addDaysYmd(from, daysAhead);
  const rules = await sb('scheduling_rules?select=key,value') || [];
  const ruleMap = ruleMapFromRows(rules);
  const prefixes = {
    habit: ruleMap.title_prefix_recurring || 'MC 🔁',
    travel: ruleMap.title_prefix_travel || 'MC 🚗',
    buffer: ruleMap.title_prefix_buffer || 'MC ⏳',
  };
  const collapsed = await collapseDuplicateIdealPins(sb, from, to);
  const missing = await healMissingPinEvents(sb, from, to, prefixes);
  const tasks = await syncTaskTimesFromGcal(sb, from, to);
  const dupes = await purgeDuplicateHabitEvents(sb, from, to, prefixes);
  return {
    from,
    to,
    ...collapsed,
    ...missing,
    ...tasks,
    ...dupes,
    push_queued: missing.inserts_queued,
  };
}

module.exports = { runPinGcalReconcile, healMissingPinEvents, purgeDuplicateHabitEvents };
