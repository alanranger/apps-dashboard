import { store } from './store.js';
import { STATES, STATE_LABEL, $, esc, fmtDate, empty } from './util.js';
import { projectChip } from './task-helpers.js';

function stalePill(t) {
  if (t.state === 'waiting' || t.owner === 'external') return '';
  const days = (Date.now() - new Date(t.last_activity_at).getTime()) / 86400000;
  if (days <= 10) return '';
  return `<span class="pill">stale ${Math.floor(days)}d</span>`;
}

export function renderBoard() {
  const switcher = store.projects.map((p) => `
    <button type="button" data-proj="${p.id}" class="${p.id === store.activeProjectId ? 'active' : ''}">
      <i class="ti ${esc(p.icon)}"></i> ${esc(p.name)}
    </button>`).join('');

  const tasks = store.tasks.filter((t) => t.project_id === store.activeProjectId);
  const cols = STATES.map((st) => {
    const list = tasks.filter((t) => t.state === st);
    const cards = list.length
      ? list.map((t) => `
        <div class="task-card ${st === 'done_claimed' ? 'done-claimed' : ''} ${st === 'verified' ? 'verified' : ''}" data-open="${t.id}">
          <div class="mcid">MC-${t.display_id} · ${esc(t.priority || 'p1')}</div>
          <div class="title">${esc(t.title)}</div>
          <div class="meta">${esc(t.owner)} · due ${fmtDate(t.due_date)} ${stalePill(t)}
          ${t.depends_on?.display_id ? `<span class="chip">depends MC-${t.depends_on.display_id}</span>` : ''}
          ${t.evidence_url ? '<i class="ti ti-link" title="evidence"></i>' : ''}
          </div>
          ${t.detail_md ? `<div class="meta card-blurb">${esc(t.detail_md.replace(/\s+/g, ' ').replace(/\*\*/g, '').slice(0, 110))}${t.detail_md.length > 110 ? '…' : ''}</div>` : '<div class="meta card-blurb danger-pill">Needs description</div>'}
        </div>`).join('')
      : empty('ti-inbox', 'No tasks in this column.');
    return `<div class="col"><h3>${STATE_LABEL[st]} (${list.length})</h3>${cards}</div>`;
  }).join('');

  $('view-board').innerHTML = `<div class="proj-switch">${switcher}</div><div class="board">${cols}</div>`;
}

export { projectChip };
