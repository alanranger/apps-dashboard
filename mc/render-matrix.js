import { store, projectById } from './store.js';
import { STATE_LABEL, esc, fmtDate } from './util.js';
import { isOverdue, execFilterActive, execFilterLabel, projectChip, easyWinsCount, ballWith, ballChipHtml } from './task-helpers.js';

const IMPACTS = ['HIGH', 'MEDIUM', 'LOW'];
const DIFFS = ['LOW', 'MEDIUM', 'HIGH'];

function level(t, field) {
  const v = String(t[field] || 'MEDIUM').toUpperCase();
  return IMPACTS.includes(v) ? v : 'MEDIUM';
}

function ragClass(impact, diff) {
  if (impact === 'HIGH' && (diff === 'LOW' || diff === 'MEDIUM')) return 'rag-high';
  if (impact === 'HIGH' || (impact === 'MEDIUM' && diff === 'LOW')) return 'rag-medium';
  return 'rag-low';
}

function filteredTasks(tasks) {
  const f = store.matrixFilter;
  if (!f) return tasks;
  return tasks.filter((t) => level(t, 'impact') === f.impact && level(t, 'difficulty') === f.diff);
}

function sortTasks(tasks) {
  const { column, direction } = store.matrixSort || { column: 'due_date', direction: 'asc' };
  const dir = direction === 'desc' ? -1 : 1;
  const rank = { HIGH: 0, MEDIUM: 1, LOW: 2, p0: 0, p1: 1, p2: 2 };
  return [...tasks].sort((a, b) => {
    let av;
    let bv;
    if (column === 'display_id') { av = a.display_id; bv = b.display_id; }
    else if (column === 'title') { av = a.title || ''; bv = b.title || ''; }
    else if (column === 'project') {
      av = projectById(a.project_id)?.name || '';
      bv = projectById(b.project_id)?.name || '';
    }
    else if (column === 'owner') { av = a.owner || ''; bv = b.owner || ''; }
    else if (column === 'ball') { av = ballWith(a).key; bv = ballWith(b).key; }
    else if (column === 'state') { av = a.state || ''; bv = b.state || ''; }
    else if (column === 'impact') { av = rank[level(a, 'impact')]; bv = rank[level(b, 'impact')]; }
    else if (column === 'difficulty') { av = rank[level(a, 'difficulty')]; bv = rank[level(b, 'difficulty')]; }
    else if (column === 'priority') { av = rank[a.priority] ?? 9; bv = rank[b.priority] ?? 9; }
    else if (column === 'due_date') { av = a.due_date || '9999'; bv = b.due_date || '9999'; }
    else { av = a.next_step || ''; bv = b.next_step || ''; }
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return a.display_id - b.display_id;
  });
}

function th(col, label, tip) {
  const s = store.matrixSort || { column: 'due_date', direction: 'asc' };
  const active = s.column === col;
  const cls = active ? (s.direction === 'asc' ? 'sort-asc' : 'sort-desc') : '';
  return `<th class="sortable ${cls}" data-sort="${col}" title="${esc(tip)}">${esc(label)} <span class="sort-indicator" aria-hidden="true"></span></th>`;
}

function badge(levelVal, kind) {
  const L = String(levelVal || 'MEDIUM').toUpperCase();
  return `<span class="lvl-badge lvl-${kind}-${L.toLowerCase()}" title="${esc(kind)}: ${L}">${L}</span>`;
}

function matrixHtml(tasks) {
  const total = tasks.length || 1;
  const f = store.matrixFilter;
  const cells = IMPACTS.map((impact) => DIFFS.map((diff) => {
    const n = tasks.filter((t) => level(t, 'impact') === impact && level(t, 'difficulty') === diff).length;
    const pct = ((n / total) * 100).toFixed(1);
    const active = f && f.impact === impact && f.diff === diff ? 'active' : '';
    return `
      <button type="button" class="pm-cell ${ragClass(impact, diff)} ${active}"
        data-matrix-impact="${impact}" data-matrix-diff="${diff}"
        title="Filter: Impact ${impact} × Difficulty ${diff}. Click again to clear.">
        <div class="pm-cell-title">${impact} / ${diff}</div>
        <div class="pm-cell-count">${n}</div>
        <div class="pm-cell-share">${pct}% of open</div>
      </button>`;
  }).join('')).map((row) => `<div class="pm-row">${row}</div>`).join('');

  const filterNote = f
    ? `Filtered: Impact <strong>${esc(f.impact)}</strong> × Difficulty <strong>${esc(f.diff)}</strong> — click the tile again to clear.`
    : 'Click a tile to filter the table (same as URL Money Pages).';

  return `
    <div class="pm-wrap">
      <div class="pm-axis-y" title="Business impact — how much this moves the needle">Impact ↑</div>
      <div class="pm-grid-block">
        <div class="pm-grid">${cells}</div>
        <div class="pm-axis-x" title="Effort / difficulty — how hard this is to finish">Difficulty →</div>
      </div>
    </div>
    <p class="meta pm-filter-note">${filterNote}</p>
    <p class="meta">Green tiles = high impact / easier wins. Set Impact &amp; Difficulty on each task in the drawer (Alan, Claude, or Cursor).</p>`;
}

function tableHtml(tasks) {
  const rows = sortTasks(filteredTasks(tasks));
  if (!rows.length) {
    return '<p class="meta" style="padding:12px 0">No tasks in this matrix cell. Click another tile or clear the filter.</p>';
  }
  const body = rows.map((t) => {
    const overdue = isOverdue(t) ? ' <span class="pill danger-pill">overdue</span>' : '';
    return `
      <tr data-open="${t.id}" title="${esc((t.detail_md || t.next_step || t.title).replace(/\s+/g, ' ').slice(0, 180))}">
        <td class="mcid mcid-nowrap">MC-${t.display_id}</td>
        <td class="td-title">${esc(t.title)}</td>
        <td class="td-project">${projectChip(t)}</td>
        <td>${esc(t.owner)}</td>
        <td>${esc(STATE_LABEL[t.state] || t.state)}</td>
        <td>${ballChipHtml(t)}</td>
        <td>${badge(level(t, 'impact'), 'impact')}</td>
        <td>${badge(level(t, 'difficulty'), 'diff')}</td>
        <td>${esc(t.priority || 'p1')}</td>
        <td class="td-due">${fmtDate(t.due_date)}${overdue}</td>
        <td class="td-next">${esc(t.next_step || '—')}</td>
      </tr>`;
  }).join('');

  return `
    <div class="pm-table-wrap">
      <table class="pm-table">
        <thead>
          <tr>
            ${th('display_id', 'MC', 'Sort by Mission Control ID')}
            ${th('title', 'Task', 'Sort by title')}
            ${th('project', 'Project', 'Sort by project stream')}
            ${th('owner', 'Owner', 'Who should act next')}
            ${th('state', 'State', 'Workflow state')}
            ${th('ball', 'Ball with', 'Who is holding the task up (derived)')}
            ${th('impact', 'Impact', 'Business impact HIGH / MEDIUM / LOW')}
            ${th('difficulty', 'Difficulty', 'Effort HIGH / MEDIUM / LOW')}
            ${th('priority', 'Pri', 'Operational priority p0 / p1 / p2')}
            ${th('due_date', 'Due', 'Due date')}
            ${th('next_step', 'Next step', 'Immediate next action')}
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </div>
    <p class="meta">${rows.length} task(s) shown · hover a row for a short tip · click to open</p>`;
}

/** Impact × Difficulty matrix + filtered sortable table (Money Pages pattern). */
export function priorityMatrixHtml(tasks) {
  const bits = [];
  if (execFilterActive()) bits.push(execFilterLabel());
  if (store.matrixFilter) bits.push(`${store.matrixFilter.impact}/${store.matrixFilter.diff}`);
  const heading = bits.length ? `Tasks (filtered: ${bits.join(' · ')})` : 'Tasks (all open)';
  const expanded = store.uiPrefs.matrixExpanded;
  const wins = easyWinsCount(tasks);
  const chev = expanded ? 'ti-chevron-up' : 'ti-chevron-down';
  return `
    <div class="card matrix-card">
      <button type="button" class="matrix-bar-toggle" data-ui-toggle="matrix" aria-expanded="${expanded}" title="Collapse or expand Impact × Difficulty matrix and table">
        <span>Priority matrix</span>
        <span class="pill">${wins} easy wins</span>
        <span class="meta matrix-bar-hint">${expanded ? 'open — click tile to filter by Impact × Difficulty' : 'collapsed — expand to filter'}</span>
        <i class="ti ${chev} matrix-bar-chev" aria-hidden="true"></i>
      </button>
      <div class="matrix-detail ${expanded ? '' : 'collapsed'}">
        <p class="meta" style="margin-bottom:12px">Impact ↑ × Difficulty → — <strong>click a matrix tile</strong> to filter this table (same as URL Money Pages). Open by default.</p>
        <div class="matrix-and-table">
          <div class="priority-matrix">${matrixHtml(tasks)}</div>
          <div class="priority-table-panel">
            <h3 class="pm-table-heading">${esc(heading)}</h3>
            ${tableHtml(tasks)}
          </div>
        </div>
      </div>
    </div>`;
}
