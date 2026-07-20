import { api } from './api.js';
import { token, setSession, clearSession } from './session.js';
import { store, applyBootstrap, taskByMc } from './store.js';
import { $ } from './util.js';
import { renderHome } from './render-home.js';
import { renderBoard } from './render-board.js';
import { openDrawer, closeDrawer } from './drawer.js';
import { openNewTaskModal } from './modal.js';

function skeletonHome() {
  $('view-home').innerHTML = '<div class="card"><div class="skeleton"></div><div class="skeleton"></div></div>';
}

function setView(name) {
  document.querySelectorAll('.views').forEach((el) => el.classList.remove('active'));
  document.querySelectorAll('.view-btn').forEach((el) => el.classList.toggle('active', el.dataset.view === name));
  $(`view-${name}`).classList.add('active');
}

function renderAll() {
  renderHome();
  renderBoard();
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
    const copy = e.target.closest('[data-copy]');
    if (copy) {
      e.preventDefault();
      try {
        await navigator.clipboard.writeText(copy.getAttribute('data-copy'));
        copy.title = 'Copied to clipboard';
      } catch (err) { /* ignore */ }
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
