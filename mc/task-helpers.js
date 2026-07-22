import { store, projectById } from './store.js';
import { esc, fmtDate, fmtTime } from './util.js';
import { occurrencesInRange } from './rrule.js';

function localYmd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const OPEN = new Set(['todo', 'in_progress', 'waiting', 'done_claimed']);
const TERMINAL = new Set(['verified', 'done', 'superseded', 'wont_do']);

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
  if (!due || TERMINAL.has(t.state)) return false;
  return due < dayStart();
}

export function isDueSoon(t, days = 2) {
  const due = parseDue(t);
  if (!due || TERMINAL.has(t.state)) return false;
  const end = dayStart();
  end.setDate(end.getDate() + days);
  return due >= dayStart() && due <= end;
}

export function projectChip(t) {
  const p = projectById(t.project_id);
  if (!p) return '';
  const idx = store.projects.findIndex((x) => x.id === p.id);
  const slot = idx >= 0 ? idx % 6 : 0;
  return `<span class="proj-pill proj-pill-${slot}"><i class="ti ${esc(p.icon)}"></i> ${esc(p.name)}</span>`;
}

export function blocksCount(taskId) {
  return store.tasks.filter((x) => x.depends_on_task_id === taskId).length;
}

export function taskWhy(t) {
  if (t.why && String(t.why).trim()) return String(t.why).trim();
  const n = blocksCount(t.id);
  if (n > 0) return `Blocks ${n} task(s)`;
  return '';
}

const BALL_KEYS = new Set(['alan', 'claude', 'cursor', 'external']);

/** Derived "Ball with" — who is holding the task up (not stored; cannot go stale). */
export function ballWith(t) {
  if (TERMINAL.has(t.state)) return { key: 'none', label: '—', style: 'none' };
  if (t.state === 'done_claimed') return { key: 'alan', label: 'alan', style: 'alan' };
  if (t.state === 'waiting') {
    const wo = String(t.waiting_on || '').trim();
    if (wo) {
      const low = wo.toLowerCase();
      const key = BALL_KEYS.has(low) ? low : 'external';
      const style = key === 'alan' ? 'alan' : 'waiting';
      return { key, label: wo, style };
    }
    const o = String(t.owner || 'alan');
    return { key: o, label: o, style: o === 'alan' ? 'alan' : 'waiting' };
  }
  const o = String(t.owner || 'alan');
  const style = o === 'alan' ? 'alan' : o === 'external' ? 'external' : 'agent';
  return { key: o, label: o, style };
}

export function ballChipHtml(t) {
  const b = ballWith(t);
  return `<span class="ball-chip ball-${b.style}" title="Ball with: ${esc(b.label)}">${esc(b.label)}</span>`;
}

export function ballCounts(tasks) {
  const c = { alan: 0, claude: 0, cursor: 0, external: 0, none: 0 };
  for (const t of tasks) {
    const k = ballWith(t).key;
    if (c[k] !== undefined) c[k] += 1;
  }
  return c;
}

export function duePillTone(t) {
  const due = parseDue(t);
  if (!due) return '';
  if (isOverdue(t)) return 'danger';
  const ms = due.getTime() - Date.now();
  if (ms <= 48 * 3600000) return 'danger';
  if (ms <= 7 * 86400000) return 'warn';
  return '';
}

const PRI_RANK = { p0: 0, p1: 1, p2: 2 };

export function nextUpTasks(tasks, limit = 3) {
  return [...tasks]
    .sort((a, b) => {
      const ao = isOverdue(a) ? 0 : 1;
      const bo = isOverdue(b) ? 0 : 1;
      if (ao !== bo) return ao - bo;
      const ad = a.due_date || '9999';
      const bd = b.due_date || '9999';
      if (ad !== bd) return ad.localeCompare(bd);
      const ap = PRI_RANK[a.priority] ?? 9;
      const bp = PRI_RANK[b.priority] ?? 9;
      if (ap !== bp) return ap - bp;
      return blocksCount(b.id) - blocksCount(a.id);
    })
    .slice(0, limit);
}

export function easyWinsCount(tasks) {
  return tasks.filter((t) => {
    const imp = String(t.impact || 'MEDIUM').toUpperCase();
    const diff = String(t.difficulty || 'MEDIUM').toUpperCase();
    return imp === 'HIGH' && (diff === 'LOW' || diff === 'MEDIUM');
  }).length;
}

export function taskLine(t, extra = '') {
  if (t.isBauRecurring) {
    return `
    <div class="plan-row plan-row-bau" data-view-jump="recurring" title="BAU recurring ops — open Recurring tab">
      <div class="mcid">BAU</div>
      <div class="plan-main">
        <div class="plan-title">${esc(t.title)}</div>
        <div class="meta"><span class="pill bau-pill">BAU · Recurring ops</span> · ${esc(t.cadence_text || '')} · ideal ${esc(t.ideal_time_label || '—')}${extra}</div>
      </div>
      <div class="meta plan-due">${fmtDate(t.due_date)}</div>
    </div>`;
  }
  return `
    <div class="plan-row" data-open="${t.id}">
      <div class="mcid">MC-${t.display_id}</div>
      <div class="plan-main">
        <div class="plan-title">${esc(t.title)}</div>
        <div class="meta">${projectChip(t)} · ${esc(t.owner)} · ${ballChipHtml(t)} · ${esc(t.state.replace('_', ' '))}${extra}</div>
      </div>
      <div class="meta plan-due">${fmtDate(t.due_date)}</div>
    </div>`;
}

/** Instances from Recurring tab habits for the planner (default 28 days — diary horizon). */
export function bauPlannerItems(days = 28) {
  const start = dayStart();
  const end = new Date(start);
  end.setDate(end.getDate() + (days - 1));
  const startYmd = localYmd(start);
  const endYmd = localYmd(end);
  const items = [];
  for (const r of store.recurring || []) {
    if (!r.active) continue;
    let dates = [];
    try { dates = occurrencesInRange(r.rrule, startYmd, endYmd); }
    catch (e) { continue; }
    for (const due of dates) {
      if (r.last_done && r.last_done >= due) continue;
      items.push({
        id: `bau-${r.id}-${due}`,
        isBauRecurring: true,
        display_id: 'BAU',
        title: r.title,
        due_date: due,
        owner: 'alan',
        state: 'todo',
        priority: 'p2',
        project_id: null,
        recurring_id: r.id,
        cadence_text: r.cadence_text,
        ideal_time_label: fmtTime(r.ideal_time),
        scheduled_note: r.scheduled_note || '',
      });
    }
  }
  return items;
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

/** Diary groups: Overdue, then each day for 28 days (MC tasks + BAU), then Undated. */
export function plannerGroups(tasks, bauItems = []) {
  const groups = [];
  const all = [...tasks, ...bauItems];
  const overdue = tasks.filter(isOverdue).sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)));
  if (overdue.length) groups.push({ key: 'overdue', label: 'Overdue', tone: 'danger', tasks: overdue });

  const start = dayStart();
  for (let i = 0; i < 28; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const key = localYmd(d);
    const dayTasks = all
      .filter((t) => t.due_date === key && !isOverdue(t))
      .sort((a, b) => {
        // BAU recurring after project tasks within the day
        if (!!a.isBauRecurring !== !!b.isBauRecurring) return a.isBauRecurring ? 1 : -1;
        return String(a.priority || 'p2').localeCompare(String(b.priority || 'p2'));
      });
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

/** Apply Dashboard exec-summary tile filters (status / priority / project / owner / ball). */
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
  if (f.ball) out = out.filter((t) => ballWith(t).key === f.ball);
  return out;
}

export function execFilterActive() {
  const f = store.execFilter || {};
  return !!(f.status || f.priority || f.projectId || f.owner || f.ball);
}

export function execFilterLabel() {
  const f = store.execFilter || {};
  const bits = [];
  if (f.status) bits.push(`status=${f.status}`);
  if (f.priority) bits.push(f.priority);
  if (f.projectId) bits.push(projectById(f.projectId)?.name || 'project');
  if (f.owner) bits.push(`owner=${f.owner}`);
  if (f.ball) bits.push(`ball=${f.ball === 'none' ? '—' : f.ball}`);
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
    inProgress, todo, byOwner, byPriority, byProject, byBall: ballCounts(tasks),
    rag, ragLabel,
  };
}
