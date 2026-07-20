import { store, projectById } from './store.js';
import { esc, fmtDate } from './util.js';

const OPEN = new Set(['todo', 'in_progress', 'waiting', 'done_claimed']);

export function openTasks() {
  return store.tasks.filter((t) => OPEN.has(t.state));
}

export function dayStart(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function parseDue(t) {
  if (!t.due_date) return null;
  return new Date(`${t.due_date}T12:00:00`);
}

export function isOverdue(t) {
  const due = parseDue(t);
  if (!due || t.state === 'verified') return false;
  return due < dayStart();
}

export function isDueSoon(t, days = 2) {
  const due = parseDue(t);
  if (!due || t.state === 'verified') return false;
  const end = dayStart();
  end.setDate(end.getDate() + days);
  return due >= dayStart() && due <= end;
}

export function projectChip(t) {
  const p = projectById(t.project_id);
  if (!p) return '';
  return `<span class="chip"><i class="ti ${esc(p.icon)}"></i> ${esc(p.name)}</span>`;
}

export function taskLine(t, extra = '') {
  return `
    <div class="plan-row" data-open="${t.id}">
      <div class="mcid">MC-${t.display_id}</div>
      <div class="plan-main">
        <div class="plan-title">${esc(t.title)}</div>
        <div class="meta">${projectChip(t)} · ${esc(t.owner)} · ${esc(t.state.replace('_', ' '))}${extra}</div>
      </div>
      <div class="meta plan-due">${fmtDate(t.due_date)}</div>
    </div>`;
}

/** Eisenhower-style for a business owner running multiple streams. */
export function matrixBuckets(tasks) {
  const doNow = [];
  const schedule = [];
  const waiting = [];
  const later = [];

  for (const t of tasks) {
    if (t.state === 'done_claimed') {
      doNow.push(t);
      continue;
    }
    if (t.state === 'waiting' || t.owner === 'external') {
      waiting.push(t);
      continue;
    }
    const urgent = isOverdue(t) || isDueSoon(t, 2) || t.priority === 'p0';
    const important = t.priority === 'p0' || t.priority === 'p1' || t.owner === 'alan';
    if (urgent && important) doNow.push(t);
    else if (important && !urgent) schedule.push(t);
    else if (urgent && !important) waiting.push(t);
    else later.push(t);
  }

  const byDue = (a, b) => String(a.due_date || '9999').localeCompare(String(b.due_date || '9999'));
  doNow.sort(byDue);
  schedule.sort(byDue);
  waiting.sort(byDue);
  later.sort(byDue);
  return { doNow, schedule, waiting, later };
}

/** Diary groups: Overdue, then each day for the next 14 days, then Undated focus. */
export function plannerGroups(tasks) {
  const groups = [];
  const overdue = tasks.filter(isOverdue).sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)));
  if (overdue.length) groups.push({ key: 'overdue', label: 'Overdue', tone: 'danger', tasks: overdue });

  const start = dayStart();
  for (let i = 0; i < 14; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const key = d.toISOString().slice(0, 10);
    const dayTasks = tasks
      .filter((t) => t.due_date === key && !isOverdue(t))
      .sort((a, b) => a.priority.localeCompare(b.priority));
    if (!dayTasks.length) continue;
    const label = i === 0 ? `Today · ${fmtDate(key)}` : i === 1 ? `Tomorrow · ${fmtDate(key)}` : fmtDate(key);
    groups.push({ key, label, tone: i === 0 ? 'today' : 'normal', tasks: dayTasks });
  }

  const undated = tasks.filter((t) => !t.due_date && t.state !== 'waiting');
  if (undated.length) {
    groups.push({
      key: 'undated',
      label: 'No date — still in play',
      tone: 'muted',
      tasks: undated.sort((a, b) => a.priority.localeCompare(b.priority)),
    });
  }
  return groups;
}

export function summaryCounts(tasks) {
  const verify = tasks.filter((t) => t.state === 'done_claimed').length;
  const waiting = tasks.filter((t) => t.state === 'waiting').length;
  const overdue = tasks.filter(isOverdue).length;
  const weekEnd = dayStart();
  weekEnd.setDate(weekEnd.getDate() + 7);
  const dueWeek = tasks.filter((t) => {
    const due = parseDue(t);
    return due && due >= dayStart() && due <= weekEnd;
  }).length;
  const active = tasks.filter((t) => t.state === 'todo' || t.state === 'in_progress').length;
  return { verify, waiting, overdue, dueWeek, active, open: tasks.length };
}
