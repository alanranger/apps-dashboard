/**
 * BAU habit write-back from Claude (NO Google Calendar access here).
 *
 * Claude POSTs what it placed in Google Calendar; this updates last_scheduled,
 * scheduled_note, rolls_used, and recurring_log only.
 */
const {
  envReady, json, cors, readBody, requireAuth, actorFromSession, sb,
} = require('./_lib');

function isYmd(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function fmtShortDate(ymd) {
  const d = new Date(`${ymd}T12:00:00`);
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function formatScheduledNote(scheduledDate, scheduledTime, idealDate, rollReason) {
  const time = String(scheduledTime || '09:00').slice(0, 5);
  if (scheduledDate === idealDate) return `${fmtShortDate(scheduledDate)} ${time}`;
  let note = `${fmtShortDate(scheduledDate)} ${time} — rolled from ${fmtShortDate(idealDate)}`;
  if (rollReason) note += `, ${rollReason}`;
  return note;
}

async function logScheduled(taskId, actor, entry) {
  const change = entry.roll_reason
    ? `scheduled ${entry.scheduled_date} (ideal ${entry.ideal_date}): ${entry.roll_reason}`
    : `scheduled ${entry.scheduled_date} (ideal ${entry.ideal_date})`;
  try {
    await sb('recurring_log', {
      method: 'POST',
      prefer: 'return=minimal',
      body: {
        recurring_task_id: taskId,
        actor,
        change,
        ideal_date: entry.ideal_date,
        scheduled_date: entry.scheduled_date,
        roll_reason: entry.roll_reason || null,
        calendar_event_id: entry.calendar_event_id || null,
        projection_key: entry.projection_key || null,
      },
    });
  } catch (e) {
    await sb('recurring_log', {
      method: 'POST',
      prefer: 'return=minimal',
      body: { recurring_task_id: taskId, actor, change },
    });
  }
}

module.exports = async function handler(req, res) {
  if (cors(req, res)) return;
  if (!envReady()) return json(res, 503, { error: 'MC_SUPABASE_NOT_CONFIGURED' });
  const session = requireAuth(req, res);
  if (!session) return;
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
  try {
    const body = await readBody(req);
    const actor = actorFromSession(session, body);
    const scheduled = Array.isArray(body?.scheduled) ? body.scheduled : [];
    const ids = [...new Set(scheduled.map((s) => s.habit_id).filter(Boolean))];
    const byId = new Map();
    if (ids.length) {
      const rows = await sb(`recurring_tasks?id=in.(${ids.join(',')})&select=id,title,rolls_used`);
      for (const r of rows || []) byId.set(r.id, r);
    }
    const updated = [];
    const unmatched = [];
    for (const s of scheduled) {
      const habit = byId.get(s.habit_id);
      if (!habit || !isYmd(s.ideal_date) || !isYmd(s.scheduled_date)) {
        unmatched.push({ habit_id: s.habit_id, projection_key: s.projection_key || null });
        continue;
      }
      const rolled = s.scheduled_date !== s.ideal_date;
      const rollsUsed = (habit.rolls_used || 0) + (rolled ? 1 : 0);
      const scheduledNote = formatScheduledNote(
        s.scheduled_date, s.scheduled_time, s.ideal_date, s.roll_reason,
      );
      await sb(`recurring_tasks?id=eq.${habit.id}`, {
        method: 'PATCH',
        prefer: 'return=minimal',
        body: {
          last_scheduled: s.scheduled_date,
          scheduled_note: scheduledNote,
          rolls_used: rollsUsed,
          updated_at: new Date().toISOString(),
        },
      });
      habit.rolls_used = rollsUsed;
      await logScheduled(habit.id, actor, s);
      updated.push({
        habit_id: habit.id,
        title: habit.title,
        ideal_date: s.ideal_date,
        scheduled_date: s.scheduled_date,
        projection_key: s.projection_key || null,
        rolls_used: rollsUsed,
        scheduled_note: scheduledNote,
      });
    }
    return json(res, 200, { updated, unmatched });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message || 'habit-scheduled error', detail: e.data });
  }
};
