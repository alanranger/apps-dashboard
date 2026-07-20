import { api } from './api.js';
import { token, setSession, clearSession } from './session.js';
import { store, applyBootstrap, taskByMc, setUiPref } from './store.js';
import { $ } from './util.js';
import { renderHome } from './render-home.js';
import { renderBoard } from './render-board.js';
import { renderRecurring, openRecurringEdit, handleRecurringClick } from './render-recurring.js';
import { openDrawer, closeDrawer } from './drawer.js';
import { openNewTaskModal } from './modal.js';

function skeletonHome() {
  $('view-home').innerHTML = '<div class="card"><div class="skeleton"></div><div class="skeleton"></div></div>';
}

function setView(name) {
  document.querySelectorAll('.views').forEach((el) => el.classList.remove('active'));
  document.querySelectorAll('.view-btn').forEach((el) => {
    const on = el.dataset.view === name;
    el.classList.toggle('active', on);
    el.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  $(`view-${name}`).classList.add('active');
  const label = $('sectionLabel');
  if (label) {
    const labels = {
      board: 'You are on: <strong>Project board</strong> — kanban by stream',
      recurring: 'You are on: <strong>Recurring</strong> — habits &amp; cadence (Reclaim replacement)',
      home: 'You are on: <strong>Dashboard</strong> — RAG overview &amp; planner',
    };
    label.innerHTML = labels[name] || labels.home;
  }
}

function renderAll() {
  renderHome();
  renderBoard();
  try {
    renderRecurring();
  } catch (e) {
    const el = $('view-recurring');
    if (el) el.innerHTML = `<div class="card"><p class="err">Recurring tab failed to render: ${e.message || e}</p></div>`;
  }
  if (store.openTaskId) openDrawer(store.openTaskId, boot);
}

async function boot() {
  skeletonHome();
  try {
    const data = await api('/api/mc/bootstrap');
    applyBootstrap(data);
    $('gate').hidden = true;
    $('app').hidden = false;
    $('roleBadge').textContent = `Signed in as ${data.role}`;
    renderAll();
  } catch (e) {
    $('gate').hidden = false;
    $('app').hidden = true;
    const err = $('gateErr');
    err.hidden = false;
    err.textContent = e.message || 'Bootstrap failed';
    if (e.status === 401) clearSession();
  }
}

async function login() {
  const err = $('gateErr');
  err.hidden = true;
  try {
    const data = await api('/api/mc/auth', { method: 'POST', body: { password: $('pw').value } });
    setSession(data.token, data.role);
    await boot();
  } catch (e) {
    err.hidden = false;
    err.textContent = e.message || 'Login failed';
  }
}

function jumpSearch(q) {
  const m = q.trim().match(/^MC-?(\d+)$/i);
  if (m) {
    const t = taskByMc(m[1]);
    if (t) {
      store.activeProjectId = t.project_id;
      setView('board');
      renderBoard();
      openDrawer(t.id, boot);
      return;
    }
  }
  const hit = store.tasks.find((t) => t.title.toLowerCase().includes(q.toLowerCase()));
  if (hit) openDrawer(hit.id, boot);
}

function wire() {
  $('loginBtn').onclick = login;
  $('pw').onkeydown = (e) => { if (e.key === 'Enter') login(); };
  $('logoutBtn').onclick = () => { clearSession(); location.reload(); };
  $('newTaskBtn').onclick = () => openNewTaskModal(boot);
  $('search').onkeydown = (e) => { if (e.key === 'Enter') jumpSearch(e.target.value); };
  $('backdrop').onclick = closeDrawer;
  $('lightbox').onclick = () => $('lightbox').classList.remove('open');
  document.querySelectorAll('.view-btn').forEach((btn) => {
    btn.onclick = () => setView(btn.dataset.view);
  });
  document.body.addEventListener('click', async (e) => {
    if (await handleRecurringClick(e, boot)) return;
    const uiToggle = e.target.closest('[data-ui-toggle]');
    if (uiToggle) {
      const key = uiToggle.getAttribute('data-ui-toggle');
      if (key === 'exec') {
        setUiPref('execExpanded', !store.uiPrefs.execExpanded);
      } else if (key === 'matrix') {
        setUiPref('matrixExpanded', !store.uiPrefs.matrixExpanded);
      }
      renderHome();
      return;
    }
    const copy = e.target.closest('[data-copy]');
    if (copy) {
      e.preventDefault();
      try {
        await navigator.clipboard.writeText(copy.getAttribute('data-copy'));
        copy.title = 'Copied to clipboard';
      } catch (err) { /* ignore */ }
      return;
    }
    const exec = e.target.closest('[data-exec-dim]');
    if (exec) {
      const dim = exec.getAttribute('data-exec-dim');
      const val = exec.getAttribute('data-exec-val');
      if (!store.execFilter) store.execFilter = { status: null, priority: null, projectId: null, owner: null };
      if (dim === 'all' || (dim === 'status' && val === 'clear')) {
        if (dim === 'all') {
          store.execFilter = { status: null, priority: null, projectId: null, owner: null };
        } else {
          store.execFilter.status = null;
        }
      } else if (store.execFilter[dim] === val) {
        store.execFilter[dim] = null;
      } else {
        store.execFilter[dim] = val;
      }
      renderHome();
      return;
    }
    const matrix = e.target.closest('[data-matrix-impact]');
    if (matrix) {
      const impact = matrix.getAttribute('data-matrix-impact');
      const diff = matrix.getAttribute('data-matrix-diff');
      const cur = store.matrixFilter;
      store.matrixFilter = cur && cur.impact === impact && cur.diff === diff
        ? null
        : { impact, diff };
      renderHome();
      return;
    }
    const sortTh = e.target.closest('th[data-sort], [data-sort]');
    if (sortTh) {
      e.preventDefault();
      e.stopPropagation();
      const column = sortTh.getAttribute('data-sort');
      if (!column) return;
      const cur = store.matrixSort || { column: 'due_date', direction: 'asc' };
      store.matrixSort = {
        column,
        direction: cur.column === column && cur.direction === 'asc' ? 'desc' : 'asc',
      };
      // Keep Dashboard visible so sorts are obvious
      setView('home');
      renderHome();
      return;
    }
    const open = e.target.closest('[data-open]');
    if (open) openDrawer(open.getAttribute('data-open'), boot);
    const ver = e.target.closest('[data-verify]');
    if (ver) {
      await api('/api/mc/actions', { method: 'POST', body: { action: 'verify', task_id: ver.getAttribute('data-verify') } });
      await boot();
    }
    const proj = e.target.closest('[data-proj]');
    if (proj) {
      store.activeProjectId = proj.getAttribute('data-proj');
      renderBoard();
    }
  });
}

wire();
if (token()) boot();
