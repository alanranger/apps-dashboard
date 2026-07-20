import { store } from './store.js';
import { $, esc, empty } from './util.js';
import {
  openTasks,
  matrixBuckets,
  plannerGroups,
  summaryCounts,
  taskLine,
  projectChip,
  isOverdue,
} from './task-helpers.js';

function summaryHtml(c) {
  const cells = [
    { n: c.overdue, label: 'Overdue', tone: c.overdue ? 'danger' : '' },
    { n: c.dueWeek, label: 'Due in 7 days', tone: '' },
    { n: c.verify, label: 'Awaiting verify', tone: c.verify ? 'danger' : '' },
    { n: c.waiting, label: 'Waiting on others', tone: c.waiting ? 'warn' : '' },
    { n: c.active, label: 'Active work', tone: '' },
    { n: c.open, label: 'Open total', tone: '' },
  ];
  return `
    <div class="summary" aria-label="Board summary">
      ${cells.map((x) => `
        <div class="summary-cell ${x.tone}">
          <div class="summary-n">${x.n}</div>
          <div class="summary-l">${x.label}</div>
        </div>`).join('')}
    </div>`;
}

function matrixHtml(buckets) {
  const q = [
    { key: 'doNow', title: 'Do now', hint: 'Overdue, due soon, P0, or needs your verify', list: buckets.doNow, tone: 'danger' },
    { key: 'schedule', title: 'Schedule', hint: 'Important — pick a date and do it', list: buckets.schedule, tone: '' },
    { key: 'waiting', title: 'Waiting / parked', hint: 'Blocked on someone else or external', list: buckets.waiting, tone: 'warn' },
    { key: 'later', title: 'Later', hint: 'P2 / low pressure — do not let these steal focus', list: buckets.later, tone: 'muted' },
  ];
  return `
    <div class="card">
      <h2>Priority matrix</h2>
      <p class="meta" style="margin-bottom:12px">Where to put attention when everything feels on fire.</p>
      <div class="matrix">
        ${q.map((cell) => `
          <div class="matrix-cell ${cell.tone}">
            <div class="matrix-head">
              <h3>${cell.title} (${cell.list.length})</h3>
              <p class="meta">${cell.hint}</p>
            </div>
            <div class="matrix-list">
              ${cell.list.length
    ? cell.list.slice(0, 8).map((t) => taskLine(t, isOverdue(t) ? ' · <span class="pill danger-pill">overdue</span>' : '')).join('')
    : '<p class="meta">Clear.</p>'}
              ${cell.list.length > 8 ? `<p class="meta">+${cell.list.length - 8} more — open Project board</p>` : ''}
            </div>
          </div>`).join('')}
      </div>
    </div>`;
}

function plannerHtml(groups) {
  if (!groups.length) {
    return `<div class="card"><h2>Planner</h2>${empty('ti-calendar', 'No dated work in the next fortnight. Add due dates on tasks so the diary fills in.')}</div>`;
  }
  return `
    <div class="card">
      <h2>Planner · next 14 days</h2>
      <p class="meta" style="margin-bottom:12px">Diary of what must move — overdue first, then by day. Click a row to open the task.</p>
      ${groups.map((g) => `
        <div class="plan-day ${g.tone}">
          <div class="plan-day-label">${esc(g.label)} · ${g.tasks.length}</div>
          ${g.tasks.map((t) => taskLine(t, t.recurrence ? ' · <span class="pill">recurring</span>' : '')).join('')}
        </div>`).join('')}
    </div>`;
}

function verifyHtml(tasks) {
  const verify = tasks.filter((t) => t.state === 'done_claimed');
  if (!verify.length) return '';
  const rows = verify.map((t) => `
    <div class="row">
      <div>${projectChip(t)}</div>
      <div>
        <div class="mcid">MC-${t.display_id}</div>
        <div>${esc(t.title)}</div>
        <div class="meta">${esc(t.claimed_by || '—')} · ${t.evidence_url ? `<a href="${esc(t.evidence_url)}" target="_blank" rel="noopener">evidence</a>` : 'no evidence'}</div>
      </div>
      <button type="button" class="btn-verify" data-verify="${t.id}" ${store.role !== 'alan' ? 'disabled title="Verify is available on Alan\'s login only"' : ''}>Verify</button>
    </div>`).join('');
  return `<div class="card"><h2>Needs your verify (${verify.length})</h2>${rows}</div>`;
}

export function renderHome() {
  const tasks = openTasks();
  const counts = summaryCounts(tasks);
  const buckets = matrixBuckets(tasks);
  const groups = plannerGroups(tasks);

  $('view-home').innerHTML = `
    ${summaryHtml(counts)}
    ${verifyHtml(tasks)}
    ${matrixHtml(buckets)}
    ${plannerHtml(groups)}
    <p class="meta" style="margin-top:8px">Google Calendar is not connected yet — this planner uses Mission Control due dates only. Project board still has the full kanban by stream.</p>`;
}
