/**
 * Clean-sweep rebuild: snapshot → delete MC-managed primary events → recreate from DB.
 * Identification rule (documented):
 *   DELETE if event id is referenced by tasks/recurring_log/travel_blocks
 *     OR title matches MC task/habit/travel/buffer patterns
 *     OR title is a known changelog corruption string
 *   NEVER delete: MC ⏰ deadlines, non-MC primary events,
 *     or colorId-10 events that do not match the rules above (listed as left_uncertain).
 *   Rest/away (MC 🛌 / MC 🚫) and fixture flanks (MC ⚽) are managed masters when
 *   present in rest_day_blocks / away_day_blocks / fixture_blocks.
const {
  insertPrimaryEvent, deletePrimaryEvent, verifyPrimaryEvent,
} = require('./gcal-write-lib');
const { fetchHorizonEvents } = require('./gcal-lib');
const {
  londonToday, addDaysYmd, mondayOnOrBefore, ruleMapFromRows,
  habitLogsToBlocks, tasksToBlocks,
} = require('./diary-lib');
const { taskGcalTitle, habitGcalTitle, travelGcalTitle, isChangelogTitle } = require('./gcal-title-lib');
const { isFixtureBlock } = require('./rule-breach-lib');

function isSkipped(change) {
  return /^skipped\b/i.test(String(change || ''));
}

function isDeadlineTitle(t, ruleMap) {
  const prefix = ruleMap.title_prefix_deadline || 'MC ⏰';
  return String(t || '').includes(prefix) || String(t || '').includes('⏰');
}

function isManagedTitle(summary, ruleMap) {
  const t = String(summary || '');
  if (isDeadlineTitle(t, ruleMap)) return false;
  if (isChangelogTitle(t)) return true;
  if (/MC 🛌|MC 🚫|REST —|AWAY —/.test(t)) return true;
  if (isFixtureBlock({ summary: t }, ruleMap)) return true;
  const habit = ruleMap.title_prefix_recurring || 'MC 🔁';
  const travel = ruleMap.title_prefix_travel || 'MC 🚗';
  const buffer = ruleMap.title_prefix_buffer || 'MC ⏳';
  if (t.includes(habit) || t.includes(travel) || t.includes(buffer)) return true;
  if (/^P[0-3]\s*·\s*MC-\d+/i.test(t)) return true;
  if (/^MC-\d+\s*[·—–-]/.test(t)) return true;
  return false;
}

function classifyEvent(e, referencedIds, ruleMap) {
  const id = e.id;
  const summary = e.summary || '';
  if (referencedIds.has(id)) return 'delete_db_ref';
  if (isDeadlineTitle(summary, ruleMap)) return 'leave_protected';
  if (isManagedTitle(summary, ruleMap)) return 'delete_pattern';
  if (e.colorId === '10' || /^MC\s/i.test(summary)) return 'leave_uncertain';
  return 'leave_other';
}

async function loadDbMasters(sb, from, to) {
  const timeMin = `${from}T00:00:00.000Z`;
  const timeMax = `${addDaysYmd(to, 1)}T00:00:00.000Z`;
  const [tasks, travel, habits, logs, rules] = await Promise.all([
    sb(`tasks?select=id,display_id,title,priority,state,scheduled_start,scheduled_end,calendar_event_id,completed_on,actual_minutes,est_minutes,last_activity_at&scheduled_start=gte.${timeMin}&scheduled_start=lt.${timeMax}&order=scheduled_start.asc`),
    sb(`travel_blocks?select=id,block_type,venue_name,workshop_title,starts_at,ends_at,calendar_event_id&starts_at=gte.${timeMin}&starts_at=lt.${timeMax}&order=starts_at.asc`),
    sb('recurring_tasks?select=id,title,duration_min,ideal_time,priority,active,last_done&active=eq.true'),
    sb(`recurring_log?select=id,recurring_task_id,ideal_date,scheduled_date,calendar_event_id,change,at&scheduled_date=gte.${from}&scheduled_date=lte.${to}&order=scheduled_date.asc`),
    sb('scheduling_rules?select=key,value'),
  ]);
  const ruleMap = ruleMapFromRows(rules || []);
  const prefixes = {
    habit: ruleMap.title_prefix_recurring || 'MC 🔁',
    travel: ruleMap.title_prefix_travel || 'MC 🚗',
    buffer: ruleMap.title_prefix_buffer || 'MC ⏳',
  };
  const habitMap = new Map((habits || []).map((h) => [h.id, h]));
  const today = londonToday();
  const activeLogs = (logs || []).filter((l) => !isSkipped(l.change));
  const habitBlocks = habitLogsToBlocks(activeLogs, habitMap).filter((b) => !b.done);
  const taskBlocks = tasksToBlocks(tasks || [], today).filter((b) => !b.done);

  const masters = [];
  for (const b of habitBlocks) {
    const habit = habitMap.get(b.habit_id);
    masters.push({
      kind: 'habit',
      db_id: b.habit_id,
      ideal_date: b.ideal_date,
      scheduled_date: b.day,
      title: habitGcalTitle(habit?.title || b.title, prefixes),
      start: b.start,
      end: b.end,
      old_event_id: b.calendar_event_id || null,
      patch_table: 'recurring_log',
    });
  }
  for (const b of taskBlocks) {
    const raw = (tasks || []).find((t) => `task:${t.id}` === b.id);
    masters.push({
      kind: 'task',
      db_id: raw?.id || b.id.replace(/^task:/, ''),
      title: taskGcalTitle({
        display_id: b.display_id,
        title: raw?.title || b.title,
        priority: raw?.priority || b.priority,
      }),
      start: b.start,
      end: b.end,
      old_event_id: b.calendar_event_id || null,
      patch_table: 'tasks',
    });
  }
  for (const row of travel || []) {
    masters.push({
      kind: 'travel',
      db_id: row.id,
      title: travelGcalTitle(row, prefixes),
      start: row.starts_at,
      end: row.ends_at,
      old_event_id: row.calendar_event_id || null,
      patch_table: 'travel_blocks',
    });
  }
  return { masters, ruleMap, prefixes, referencedIds: new Set(masters.map((m) => m.old_event_id).filter(Boolean)) };
}

async function snapshotPrimaryMc(timeMin, timeMax, referencedIds, ruleMap) {
  const { events } = await fetchHorizonEvents(timeMin, timeMax);
  const primary = (events || []).filter((e) => e._calendarId === 'primary');
  const rows = primary.map((e) => {
    const start = e.start?.dateTime || e.start?.date || null;
    const end = e.end?.dateTime || e.end?.date || null;
    const action = classifyEvent(e, referencedIds, ruleMap);
    return {
      id: e.id,
      summary: e.summary || '',
      start,
      end,
      colorId: e.colorId || null,
      action,
    };
  });
  return {
    snapshot_at: new Date().toISOString(),
    timeMin,
    timeMax,
    count: rows.length,
    to_delete: rows.filter((r) => r.action.startsWith('delete')),
    left_protected: rows.filter((r) => r.action === 'leave_protected'),
    left_uncertain: rows.filter((r) => r.action === 'leave_uncertain'),
    left_other: rows.filter((r) => r.action === 'leave_other'),
    rows,
  };
}

async function deleteManaged(snapshot) {
  const deleted = [];
  const failed = [];
  for (const row of snapshot.to_delete || []) {
    try {
      await deletePrimaryEvent(row.id);
      deleted.push(row.id);
    } catch (e) {
      failed.push({ id: row.id, error: e.message });
    }
  }
  return { deleted_count: deleted.length, failed, deleted };
}

async function recreateFromDb(sb, masters, { sleepMs = 80 } = {}) {
  const created = [];
  const failed = [];
  for (const m of masters) {
    try {
      const ev = await insertPrimaryEvent({
        summary: m.title,
        startIso: m.start,
        endIso: m.end,
      });
      const v = await verifyPrimaryEvent(ev.id, {
        summary: m.title,
        startIso: m.start,
        endIso: m.end,
      });
      if (!v.ok) {
        failed.push({ ...m, error: 'readback_mismatch', verify: v, event_id: ev.id });
        continue;
      }
      if (m.patch_table === 'tasks') {
        await sb(`tasks?id=eq.${m.db_id}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: { calendar_event_id: ev.id },
        });
      } else if (m.patch_table === 'travel_blocks') {
        await sb(`travel_blocks?id=eq.${m.db_id}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: { calendar_event_id: ev.id },
        });
      } else if (m.patch_table === 'recurring_log' && m.scheduled_date) {
        await sb(
          `recurring_log?recurring_task_id=eq.${m.db_id}&scheduled_date=eq.${m.scheduled_date}`,
          {
            method: 'PATCH', prefer: 'return=minimal',
            body: { calendar_event_id: ev.id },
          },
        );
      }
      created.push({
        kind: m.kind, db_id: m.db_id, title: m.title, start: m.start, end: m.end, event_id: ev.id,
      });
      if (sleepMs) await new Promise((r) => setTimeout(r, sleepMs));
    } catch (e) {
      failed.push({ kind: m.kind, db_id: m.db_id, title: m.title, error: e.message });
    }
  }
  return { created_count: created.length, failed_count: failed.length, created, failed };
}

function defaultHorizon() {
  const today = londonToday();
  const from = addDaysYmd(mondayOnOrBefore(today), -7);
  const to = addDaysYmd(from, 52 * 7 - 1);
  return { from, to, timeMin: `${from}T00:00:00.000Z`, timeMax: `${addDaysYmd(to, 1)}T00:00:00.000Z` };
}

module.exports = {
  loadDbMasters,
  snapshotPrimaryMc,
  deleteManaged,
  recreateFromDb,
  classifyEvent,
  isManagedTitle,
  defaultHorizon,
};
