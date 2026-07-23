/** Build per-day task+habit competition pools for priority placement. */
const { occurrencesInRange } = require('./rrule-core');
const { simulateDayPlacement } = require('./priority-lib');

const OPEN_STATES = 'todo,in_progress,waiting';

async function fetchCompetingPool(sb, from, to) {
  const [tasks, habits] = await Promise.all([
    sb(`tasks?select=display_id,title,priority,est_minutes,due_date,state,completed_on,slot_pinned&state=in.(${OPEN_STATES})&due_date=gte.${from}&due_date=lte.${to}`),
    sb('recurring_tasks?select=id,title,priority,duration_min,rrule,active&active=eq.true'),
  ]);
  return { tasks: tasks || [], habits: habits || [] };
}

function itemsForDate(date, tasks, habits) {
  const items = [];
  for (const t of tasks) {
    if (t.due_date !== date || t.completed_on || t.slot_pinned) continue;
    items.push({
      kind: 'task',
      id: t.display_id,
      title: t.title,
      priority: t.priority || 'p1',
      duration_min: t.est_minutes || 0,
    });
  }
  for (const h of habits) {
    let onDay = false;
    try { onDay = occurrencesInRange(h.rrule, date, date).includes(date); } catch { onDay = false; }
    if (!onDay) continue;
    items.push({
      kind: 'habit',
      id: h.id,
      title: h.title,
      priority: h.priority || 'p1',
      duration_min: h.duration_min || 60,
    });
  }
  return items;
}

function competitionForRange(from, to, tasks, habits, capMin) {
  const byDate = {};
  let cur = from;
  while (cur <= to) {
    const items = itemsForDate(cur, tasks, habits);
    byDate[cur] = items.length
      ? simulateDayPlacement(items, capMin)
      : { placed: [], displaced: [], minutes_used: 0, cap_min: capMin, item_count: 0 };
    cur = addDays(cur, 1);
  }
  return byDate;
}

function addDays(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

module.exports = { fetchCompetingPool, itemsForDate, competitionForRange };
