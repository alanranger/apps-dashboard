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
    { n: c.overdue, label: 'Overdue', tone: c.overdue ? 'danger' : 'ok' },
    { n: c.dueWeek, label: 'Due in 7 days', tone: c.dueWeek && !c.overdue ? 'warn' : (c.dueWeek ? 'warn' : 'ok') },
    { n: c.inProgress, label: 'In progress', tone: c.inProgress ? 'warn' : 'ok' },
    { n: c.todo, label: 'To do', tone: '' },
    { n: c.verify, label: 'Awaiting verify', tone: c.verify ? 'danger' : 'ok' },
    { n: c.waiting, label: 'Waiting on others', tone: c.waiting ? 'warn' : 'ok' },
    { n: c.open, label: 'Open total', tone: '' },
  ];
  const owners = [
    ['alan', c.byOwner.alan],
    ['claude', c.byOwner.claude],
    ['cursor', c.byOwner.cursor],
    ['external', c.byOwner.external],
  ];
  return `
    <div class="card exec-card rag-${c.rag}" aria-label="Executive summary">
      <div class="exec-head">
        <div class="rag-badge rag-${c.rag}">${c.rag === 'red' ? 'RED' : c.rag === 'amber' ? 'AMBER' : 'GREEN'}</div>
        <div>
          <h2>Executive summary</h2>
          <p class="exec-verdict">${esc(c.ragLabel)}</p>
          <p class="meta">${c.open} open · ${c.active} active (todo + in progress) · ${c.byOwner.alan} on you · ${c.byOwner.claude} Claude · ${c.byOwner.cursor} Cursor</p>
        </div>
      </div>
      <div class="summary" aria-label="Task counts">
        ${cells.map((x) => `
          <div class="summary-cell ${x.tone}">
            <div class="summary-n">${x.n}</div>
            <div class="summary-l">${x.label}</div>
          </div>`).join('')}
      </div>
      <div class="owner-strip" aria-label="By owner">
        ${owners.map(([name, n]) => `<span class="owner-chip"><strong>${n}</strong> ${name}</span>`).join('')}
      </div>
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
    ? cell.list.map((t) => taskLine(t, isOverdue(t) ? ' · <span class="pill danger-pill">overdue</span>' : '')).join('')
    : '<p class="meta">Clear.</p>'}
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
    <div class="card">
      <h2>Claude ↔ Cursor workflow (how this ties in)</h2>
      <p class="meta" style="margin-bottom:12px">
        Mission Control is the <strong>task board</strong>. The Drive loop is still the <strong>long-form</strong> handoff (“check claude”).
        Both agents must read MC notes + screenshots on tasks assigned to them.
      </p>
      <div class="workflow-grid">
        <div class="inset">
          <div class="meta">Board of truth</div>
          <p><strong>Mission Control</strong> — MC-IDs, owner (alan / claude / cursor), due dates, notes, screenshots, verify.</p>
          <p class="meta">Repo: <a href="https://github.com/alanranger/apps-dashboard" target="_blank" rel="noopener">alanranger/apps-dashboard</a></p>
        </div>
        <div class="inset">
          <div class="meta">Long-form handoff (check claude)</div>
          <p><strong>Inbox:</strong> Google Drive → Claude Questions for Cursor</p>
          <p><strong>Outbox:</strong> Google Drive → Cursor Outputs for Claude</p>
          <p class="meta">Link files on a task via Q / R handoff refs (include MC-14 in filenames).</p>
        </div>
        <div class="inset">
          <div class="meta">Main app repos</div>
          <p><a href="https://github.com/alanranger/ai-geo-audit" target="_blank" rel="noopener">ai-geo-audit</a></p>
          <p><a href="https://github.com/alanranger/alan-chat-proxy" target="_blank" rel="noopener">alan-chat-proxy</a> (Chat AI Bot)</p>
          <p><a href="https://github.com/alanranger/apps-dashboard" target="_blank" rel="noopener">apps-dashboard</a> (this board)</p>
        </div>
        <div class="inset">
          <div class="meta">Who acts</div>
          <p>Task <strong>owner</strong> = who should work it next. Your notes/screenshots are the reply channel for both Claude and Cursor.</p>
          <p class="meta">Full map: <a href="/handoff">/handoff</a></p>
        </div>
      </div>
    </div>
    <p class="meta" style="margin-top:8px">Google Calendar is not connected yet — planner uses MC due dates only.</p>`;
}
