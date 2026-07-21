import { store } from './store.js';
import { $, esc, empty, fmtDate } from './util.js';
import {
  openTasks,
  plannerGroups,
  summaryCounts,
  taskLine,
  projectChip,
  applyExecFilter,
  execFilterActive,
  execFilterLabel,
  nextUpTasks,
  taskWhy,
  duePillTone,
  bauPlannerItems,
  ballChipHtml,
} from './task-helpers.js';
import { priorityMatrixHtml } from './render-matrix.js';

function tileRow(label, cells, aria) {
  return `
    <div class="exec-row">
      <div class="exec-row-label">${esc(label)}</div>
      <div class="summary" aria-label="${esc(aria)}">
        ${cells.map((x) => `
          <button type="button" class="summary-cell ${x.tone || ''} ${x.active ? 'active' : ''}"
            data-exec-dim="${esc(x.dim)}" data-exec-val="${esc(x.val)}"
            title="${esc(x.tip || `Filter table: ${x.label}`)}">
            <div class="summary-n">${x.n}</div>
            <div class="summary-l">${esc(x.label)}</div>
          </button>`).join('')}
      </div>
    </div>`;
}

function execDetailHtml(c) {
  const f = store.execFilter || {};
  const byStatus = [
    { n: c.verify, label: 'Awaiting verify', tone: c.verify ? 'danger' : 'ok', dim: 'status', val: 'verify', active: f.status === 'verify' },
    { n: c.overdue, label: 'Overdue', tone: c.overdue ? 'danger' : 'ok', dim: 'status', val: 'overdue', active: f.status === 'overdue' },
    { n: c.dueWeek, label: 'Due in 7 days', tone: c.dueWeek ? 'warn' : 'ok', dim: 'status', val: 'dueWeek', active: f.status === 'dueWeek' },
    { n: c.inProgress, label: 'In progress', tone: c.inProgress ? 'warn' : 'ok', dim: 'status', val: 'in_progress', active: f.status === 'in_progress' },
    { n: c.todo, label: 'To do', tone: '', dim: 'status', val: 'todo', active: f.status === 'todo' },
    { n: c.waiting, label: 'Waiting on others', tone: c.waiting ? 'warn' : 'ok', dim: 'status', val: 'waiting', active: f.status === 'waiting' },
    { n: c.open, label: 'Open total', tone: '', dim: 'status', val: 'clear', tip: 'Clear status filter (keep project/priority/owner)', active: !f.status },
  ];
  const byPri = [
    { n: c.byPriority.p0, label: 'p0 urgent', tone: c.byPriority.p0 ? 'danger' : 'ok', dim: 'priority', val: 'p0', active: f.priority === 'p0' },
    { n: c.byPriority.p1, label: 'p1 important', tone: c.byPriority.p1 ? 'warn' : 'ok', dim: 'priority', val: 'p1', active: f.priority === 'p1' },
    { n: c.byPriority.p2, label: 'p2 later', tone: '', dim: 'priority', val: 'p2', active: f.priority === 'p2' },
  ];
  const byProject = c.byProject.map((p) => ({
    n: p.n,
    label: p.name,
    tone: p.n >= 8 ? 'warn' : '',
    dim: 'projectId',
    val: p.id,
    tip: `Filter table: ${p.name}`,
    active: f.projectId === p.id,
  }));
  const owners = [
    ['alan', c.byOwner.alan],
    ['claude', c.byOwner.claude],
    ['cursor', c.byOwner.cursor],
    ['external', c.byOwner.external],
  ];
  const balls = [
    ['alan', c.byBall.alan, 'you'],
    ['claude', c.byBall.claude, 'claude'],
    ['cursor', c.byBall.cursor, 'cursor'],
    ['external', c.byBall.external, 'external'],
    ['none', c.byBall.none, '—'],
  ];
  const filterNote = execFilterActive()
    ? `<p class="meta exec-filter-note">Table filtered: <strong>${esc(execFilterLabel())}</strong> — click a tile again to clear that filter, or <button type="button" class="linkish" data-exec-dim="all" data-exec-val="clear">Clear all filters</button></p>`
    : '<p class="meta exec-filter-note">Click any tile (or owner / Ball with) to filter the task table below. Click again to clear.</p>';
  return `
    ${tileRow('By status', byStatus, 'Filter by progress status')}
    ${tileRow('By priority', byPri, 'Filter by operational priority')}
    ${tileRow('By project', byProject, 'Filter by project stream')}
    <div class="owner-strip" aria-label="Filter by owner">
      <span class="meta" style="margin-right:4px">By owner:</span>
      ${owners.map(([name, n]) => `
        <button type="button" class="owner-chip ${f.owner === name ? 'active' : ''}"
          data-exec-dim="owner" data-exec-val="${name}" title="Filter table: owner ${name}">
          <strong>${n}</strong> ${name}
        </button>`).join('')}
    </div>
    <div class="owner-strip ball-strip" aria-label="Filter by ball with">
      <span class="meta" style="margin-right:4px">Ball with:</span>
      ${balls.map(([key, n, label]) => `
        <button type="button" class="owner-chip ball-filter-${key} ${f.ball === key ? 'active' : ''}"
          data-exec-dim="ball" data-exec-val="${key}" title="Filter table: ball with ${label}">
          <strong>${n}</strong> ${label}
        </button>`).join('')}
    </div>
    ${filterNote}`;
}

function summaryHtml(c) {
  const expanded = store.uiPrefs.execExpanded;
  const ragLabel = c.rag === 'red' ? 'RED' : c.rag === 'amber' ? 'AMBER' : 'GREEN';
  const chev = expanded ? 'ti-chevron-up' : 'ti-chevron-down';
  return `
    <div class="card exec-card rag-${c.rag}" aria-label="Executive summary">
      <button type="button" class="exec-bar-toggle" data-ui-toggle="exec" aria-expanded="${expanded}" title="Collapse or expand the count tiles">
        <span class="rag-badge rag-${c.rag}">${ragLabel}</span>
        <span class="exec-bar-main">${c.open} open · ${c.dueWeek} due this week · ${c.waiting} waiting</span>
        <span class="exec-bar-side">${c.overdue} overdue · ${c.verify} to verify · ${c.byOwner.alan} on you</span>
        <span class="exec-bar-ball meta">Ball: you ${c.byBall.alan} · claude ${c.byBall.claude} · cursor ${c.byBall.cursor} · external ${c.byBall.external}</span>
        <i class="ti ${chev} exec-bar-chev" aria-hidden="true"></i>
      </button>
      <div class="exec-detail ${expanded ? '' : 'collapsed'}">
        <p class="exec-verdict">${esc(c.ragLabel)}</p>
        <p class="meta" style="margin-bottom:8px">Tiles open by default — click a tile to filter the matrix table. Chevron only collapses if you want a quieter view.</p>
        ${execDetailHtml(c)}
      </div>
    </div>`;
}

function nextUpHtml(tasks) {
  const top = nextUpTasks(tasks, 3);
  if (!top.length) {
    return `<div class="card"><h2>Next up — and why</h2>${empty('ti-list-check', 'No open tasks — enjoy the quiet.')}</div>`;
  }
  const rows = top.map((t) => {
    const why = taskWhy(t);
    const tone = duePillTone(t);
    const due = t.due_date ? fmtDate(t.due_date) : '—';
    return `
      <div class="nextup-row" data-open="${t.id}">
        <span class="mcid mcid-nowrap">MC-${t.display_id}</span>
        <div class="nextup-main">
          <div class="nextup-title">${esc(t.title)}</div>
          <div class="nextup-meta">${projectChip(t)} ${ballChipHtml(t)}${why ? `<span class="nextup-why meta">${esc(why)}</span>` : ''}</div>
        </div>
        <span class="due-pill ${tone ? `due-pill-${tone}` : ''}">${esc(due)}</span>
      </div>`;
  }).join('');
  return `
    <div class="card">
      <h2>Next up — and why</h2>
      <p class="meta" style="margin-bottom:8px">Top 3 open tasks — overdue first, then due date, priority, blockers.</p>
      ${rows}
    </div>`;
}

function plannerHtml(groups) {
  if (!groups.length) {
    return `<div class="card"><h2>Planner</h2>${empty('ti-calendar', 'No dated work in the next fortnight. Add due dates on tasks so the diary fills in.')}</div>`;
  }
  const bauCount = groups.reduce((n, g) => n + g.tasks.filter((t) => t.isBauRecurring).length, 0);
  return `
    <div class="card">
      <h2>Planner · next 28 days</h2>
      <p class="meta" style="margin-bottom:12px">
        Project tasks (14-day focus) + <strong>BAU Recurring ops</strong> out to <strong>28 days</strong>
        ${bauCount ? `(${bauCount} habit instance${bauCount === 1 ? '' : 's'})` : ''}.
        Claude books diary time 28 days ahead. Add habits on the <strong>Recurring</strong> tab → Add habit.
      </p>
      ${groups.map((g) => `
        <div class="plan-day ${g.tone}">
          <div class="plan-day-label">${esc(g.label)} · ${g.tasks.length}</div>
          ${g.tasks.map((t) => taskLine(t, t.recurrence && !t.isBauRecurring ? ' · <span class="pill">recurring</span>' : '')).join('')}
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
        <div class="mcid mcid-nowrap">MC-${t.display_id}</div>
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
  const tableTasks = applyExecFilter(tasks);
  const groups = plannerGroups(tableTasks, bauPlannerItems(28));

  $('view-home').innerHTML = `
    ${summaryHtml(counts)}
    ${nextUpHtml(tasks)}
    ${verifyHtml(tasks)}
    ${priorityMatrixHtml(tableTasks)}
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
    <p class="meta" style="margin-top:8px">Planner = MC due dates + BAU recurring instances. Google Calendar placement stays Claude-only.</p>`;
}
