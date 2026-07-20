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

/** Apply Dashboard exec-summary tile filters (status / priority / project / owner). */
export function applyExecFilter(tasks) {
  const f = store.execFilter || {};
  let out = tasks;
  const weekEnd = dayStart();
  weekEnd.setDate(weekEnd.getDate() + 7);
  if (f.status === 'overdue') out = out.filter(isOverdue);
  else if (f.status === 'dueWeek') {
    out = out.filter((t) => {
      const due = parseDue(t);
      return due && due >= dayStart() && due <= weekEnd;
    });
  } else if (f.status === 'in_progress') out = out.filter((t) => t.state === 'in_progress');
  else if (f.status === 'todo') out = out.filter((t) => t.state === 'todo');
  else if (f.status === 'verify') out = out.filter((t) => t.state === 'done_claimed');
  else if (f.status === 'waiting') out = out.filter((t) => t.state === 'waiting');
  if (f.priority) out = out.filter((t) => t.priority === f.priority);
  if (f.projectId) out = out.filter((t) => t.project_id === f.projectId);
  if (f.owner) out = out.filter((t) => t.owner === f.owner);
  return out;
}

export function execFilterActive() {
  const f = store.execFilter || {};
  return !!(f.status || f.priority || f.projectId || f.owner);
}

export function execFilterLabel() {
  const f = store.execFilter || {};
  const bits = [];
  if (f.status) bits.push(`status=${f.status}`);
  if (f.priority) bits.push(f.priority);
  if (f.projectId) bits.push(projectById(f.projectId)?.name || 'project');
  if (f.owner) bits.push(f.owner);
  return bits.length ? bits.join(' · ') : '';
}

export function summaryCounts(tasks) {
  const verify = tasks.filter((t) => t.state === 'done_claimed').length;
  const waiting = tasks.filter((t) => t.state === 'waiting').length;
  const overdue = tasks.filter(isOverdue).length;
  const inProgress = tasks.filter((t) => t.state === 'in_progress').length;
  const todo = tasks.filter((t) => t.state === 'todo').length;
  const weekEnd = dayStart();
  weekEnd.setDate(weekEnd.getDate() + 7);
  const dueWeek = tasks.filter((t) => {
    const due = parseDue(t);
    return due && due >= dayStart() && due <= weekEnd;
  }).length;
  const active = todo + inProgress;
  const byOwner = { alan: 0, claude: 0, cursor: 0, external: 0 };
  const byPriority = { p0: 0, p1: 0, p2: 0 };
  const byProjectMap = new Map();
  for (const t of tasks) {
    if (byOwner[t.owner] !== undefined) byOwner[t.owner] += 1;
    if (byPriority[t.priority] !== undefined) byPriority[t.priority] += 1;
    const p = projectById(t.project_id);
    const key = p?.id || 'unknown';
    const cur = byProjectMap.get(key) || { id: key, name: p?.name || 'Unknown', icon: p?.icon || 'ti-folder', n: 0 };
    cur.n += 1;
    byProjectMap.set(key, cur);
  }
  const byProject = [...byProjectMap.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
  let rag = 'green';
  let ragLabel = 'GREEN — nothing on fire';
  if (overdue > 0 || verify > 0) {
    rag = 'red';
    ragLabel = overdue
      ? `RED — ${overdue} overdue${verify ? `, ${verify} need verify` : ''}`
      : `RED — ${verify} awaiting your verify`;
  } else if (dueWeek > 0 || waiting > 0 || inProgress > 0) {
    rag = 'amber';
    ragLabel = `AMBER — ${dueWeek} due in 7 days · ${inProgress} in progress · ${waiting} waiting`;
  }
  return {
    verify, waiting, overdue, dueWeek, active, open: tasks.length,
    inProgress, todo, byOwner, byPriority, byProject, rag, ragLabel,
  };
}
