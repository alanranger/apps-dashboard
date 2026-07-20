(() => {
  const TOKEN_KEY = 'mc_session_token';
  const ROLE_KEY = 'mc_session_role';
  const STATES = ['todo', 'in_progress', 'waiting', 'done_claimed', 'verified'];
  const STATE_LABEL = {
    todo: 'To do',
    in_progress: 'In progress',
    waiting: 'Waiting',
    done_claimed: 'Done-claimed',
    verified: 'Verified',
  };

  let state = { role: null, projects: [], tasks: [], checklist: [], comments: [], log: [] };
  let activeProjectId = null;
  let openTaskId = null;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

  function token() { return sessionStorage.getItem(TOKEN_KEY) || ''; }
  function setSession(t, role) {
    sessionStorage.setItem(TOKEN_KEY, t);
    sessionStorage.setItem(ROLE_KEY, role);
  }
  function clearSession() {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(ROLE_KEY);
  }

  function agentActor() {
    return sessionStorage.getItem(ROLE_KEY) === 'alan' ? 'alan' : 'cursor';
  }

  async function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (token()) headers.Authorization = `Bearer ${token()}`;
    let body = opts.body;
    if (body && typeof body === 'object' && !body.actor) body = { ...body, actor: agentActor() };
    const res = await fetch(path, { ...opts, headers, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { data, status: res.status });
    return data;
  }

  function fmtDate(d) {
    if (!d) return '—';
    const dt = new Date(d + (String(d).length === 10 ? 'T12:00:00' : ''));
    return dt.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  }

  function projectById(id) { return state.projects.find((p) => p.id === id); }
  function taskById(id) { return state.tasks.find((t) => t.id === id); }
  function taskByMc(n) { return state.tasks.find((t) => Number(t.display_id) === Number(n)); }

  function stalePill(t) {
    if (t.state === 'waiting' || t.owner === 'external') return '';
    const days = (Date.now() - new Date(t.last_activity_at).getTime()) / 86400000;
    if (days <= 10) return '';
    return `<span class="pill">stale ${Math.floor(days)}d</span>`;
  }

  function projectChip(t) {
    const p = projectById(t.project_id);
    if (!p) return '';
    return `<span class="chip"><i class="ti ${esc(p.icon)}"></i> ${esc(p.name)}</span>`;
  }

  function empty(icon, text, actionHtml = '') {
    return `<div class="empty"><i class="ti ${icon}"></i><p>${esc(text)}</p>${actionHtml}</div>`;
  }

  function handoffRef(label, file) {
    if (!file) return `${label}: —`;
    if (/^https?:\/\//i.test(file)) {
      return `${label}: <a href="${esc(file)}" target="_blank" rel="noopener">${esc(file)}</a>`;
    }
    return `${label}: <a href="#" class="handoff-ref" data-copy="${esc(file)}" title="Google Drive handoff file">${esc(file)}</a>`;
  }

  function skeletonHome() {
    $('view-home').innerHTML = '<div class="card"><div class="skeleton"></div><div class="skeleton"></div></div>';
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

  async function boot() {
    skeletonHome();
    try {
      const data = await api('/api/mc/bootstrap');
      state = { ...state, ...data };
      activeProjectId = state.projects[0]?.id || null;
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

  function renderAll() {
    renderHome();
    renderBoard();
    if (openTaskId) openDrawer(openTaskId);
  }

  function renderHome() {
    const verify = state.tasks.filter((t) => t.state === 'done_claimed')
      .sort((a, b) => String(b.claimed_at || '').localeCompare(String(a.claimed_at || '')));
    const waiting = state.tasks.filter((t) => t.state === 'waiting')
      .sort((a, b) => String(a.due_date || '9999').localeCompare(String(b.due_date || '9999')));
    const soonEnd = Date.now() + 7 * 86400000;
    const next7 = state.tasks.filter((t) => t.due_date && new Date(t.due_date).getTime() <= soonEnd && t.state !== 'verified')
      .sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)));

    const verRows = verify.length ? verify.map((t) => `
      <div class="row">
        <div>${projectChip(t)}</div>
        <div>
          <div class="mcid">MC-${t.display_id}</div>
          <div>${esc(t.title)}</div>
          <div class="meta">${esc(t.claimed_by || '—')} · ${t.evidence_url ? `<a href="${esc(t.evidence_url)}" target="_blank" rel="noopener">evidence</a>` : 'no evidence'}</div>
        </div>
        <button type="button" class="btn-verify" data-verify="${t.id}" ${state.role !== 'alan' ? 'disabled title="Verify is available on Alan\'s login only"' : ''}>Verify</button>
      </div>`).join('') : empty('ti-shield-check', 'Nothing awaiting your verification — enjoy it.');

    const waitRows = waiting.length ? waiting.map((t) => `
      <div class="row" data-open="${t.id}" style="cursor:pointer">
        <div>${projectChip(t)}</div>
        <div><div class="mcid">MC-${t.display_id}</div><div>${esc(t.title)}</div>
        <div class="meta">${esc(t.waiting_on || '—')} · ${fmtDate(t.due_date)}</div></div>
        <div></div>
      </div>`).join('') : empty('ti-hourglass', 'Nothing waiting on the world right now.');

    const nextRows = next7.length ? next7.map((t) => `
      <div class="row" data-open="${t.id}" style="cursor:pointer">
        <div class="meta">${fmtDate(t.due_date)}</div>
        <div><div class="mcid">MC-${t.display_id}</div><div>${esc(t.title)}</div>
        <div class="meta">${esc(t.owner)}${t.recurrence ? ' · <span class="pill">recurring</span>' : ''}</div></div>
        <div></div>
      </div>`).join('') : empty('ti-calendar', 'No due dates in the next 7 days.');

    $('view-home').innerHTML = `
      <div class="card"><h2>🛡 Awaiting your verification (${verify.length})</h2>${verRows}</div>
      <div class="card"><h2>⏳ Waiting on the world (${waiting.length})</h2>${waitRows}</div>
      <div class="card"><h2>📅 Next 7 days (${next7.length})</h2>${nextRows}</div>`;
  }

  function renderBoard() {
    const switcher = state.projects.map((p) => `
      <button type="button" data-proj="${p.id}" class="${p.id === activeProjectId ? 'active' : ''}">
        <i class="ti ${esc(p.icon)}"></i> ${esc(p.name)}
      </button>`).join('');

    const tasks = state.tasks.filter((t) => t.project_id === activeProjectId);
    const cols = STATES.map((st) => {
      const list = tasks.filter((t) => t.state === st);
      const cards = list.length ? list.map((t) => `
        <div class="task-card ${st === 'done_claimed' ? 'done-claimed' : ''} ${st === 'verified' ? 'verified' : ''}" data-open="${t.id}">
          <div class="mcid">MC-${t.display_id}</div>
          <div class="title">${esc(t.title)}</div>
          <div class="meta">${esc(t.owner)} · ${fmtDate(t.due_date)} ${stalePill(t)}
          ${t.depends_on?.display_id ? `<span class="chip">depends MC-${t.depends_on.display_id}</span>` : ''}
          ${t.evidence_url ? '<i class="ti ti-link" title="evidence"></i>' : ''}
          </div>
        </div>`).join('') : empty('ti-inbox', 'No tasks in this column.');
      return `<div class="col"><h3>${STATE_LABEL[st]} (${list.length})</h3>${cards}</div>`;
    }).join('');

    $('view-board').innerHTML = `<div class="proj-switch">${switcher}</div><div class="board">${cols}</div>`;
  }

  function commentsFor(taskId) {
    return state.comments.filter((c) => c.task_id === taskId).sort((a, b) => String(b.at).localeCompare(String(a.at)));
  }

  function logFor(taskId) {
    return state.log.filter((l) => l.task_id === taskId).sort((a, b) => String(b.at).localeCompare(String(a.at)));
  }

  function checksFor(taskId) {
    return state.checklist.filter((c) => c.task_id === taskId).sort((a, b) => a.sort - b.sort);
  }

  async function openDrawer(taskId) {
    const t = taskById(taskId);
    if (!t) return;
    openTaskId = taskId;
    const checks = checksFor(taskId).map((c) => `
      <label class="check-item"><input type="checkbox" data-check="${c.id}" ${c.done ? 'checked' : ''}/> ${esc(c.label)}</label>`).join('')
      || '<p class="meta">No checklist items.</p>';
    const comments = commentsFor(taskId).map((c) => `
      <div class="inset">
        <div class="meta">${esc(c.author)} · ${fmtDate(c.at)} · ${esc(c.kind || 'comment')}</div>
        <div>${esc(c.body_md)}</div>
        <div class="thumbs" data-paths="${esc((c.image_urls || []).join(','))}"></div>
      </div>`).join('') || '<p class="meta">No comments yet.</p>';
    const timeline = logFor(taskId).map((l) => `
      <div class="item"><strong>${esc(l.actor)}</strong> · ${fmtDate(l.at)}<br>${esc(l.change)}</div>`).join('')
      || '<div class="item">No activity yet.</div>';

    $('drawer').innerHTML = `
      <div class="drawer-body">
        <div class="meta">MC-${t.display_id}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin:8px 0">${projectChip(t)}<span class="chip">${esc(STATE_LABEL[t.state])}</span></div>
        <h2 style="font-size:16px;font-weight:600">${esc(t.title)}</h2>
        <p class="meta">${esc(t.owner)} · due ${fmtDate(t.due_date)}${t.claimed_by ? ` · claimed by ${esc(t.claimed_by)}` : ''}</p>
        <div class="inset"><div class="meta">Next step</div><div>${esc(t.next_step || '—')}</div></div>
        <h3 style="font-size:14px;font-weight:600;margin-top:12px">Checklist</h3>
        ${checks}
        <h3 style="font-size:14px;font-weight:600;margin-top:12px">Evidence</h3>
        <div class="inset">${t.evidence_url ? `<a href="${esc(t.evidence_url)}" target="_blank" rel="noopener">${esc(t.evidence_url)}</a>` : 'None yet'}
        <div style="margin-top:8px"><input id="evidenceInput" placeholder="Evidence URL" value="${esc(t.evidence_url || '')}" style="width:100%;padding:8px"/>
        <button type="button" id="saveEvidence" style="margin-top:8px">Save evidence / claim done</button></div></div>
        <h3 style="font-size:14px;font-weight:600;margin-top:12px">Handoff refs</h3>
        <div class="inset meta">
          ${handoffRef('Q', t.question_file)}<br>
          ${handoffRef('R', t.response_file)}
        </div>
        <h3 style="font-size:14px;font-weight:600;margin-top:12px">Comments</h3>
        <div id="commentBox" class="inset">
          <textarea id="commentText" rows="3" placeholder="Comment… paste or drop images" style="width:100%;padding:8px"></textarea>
          <div id="pendingThumbs" class="thumbs"></div>
          <button type="button" id="postComment" style="margin-top:8px">Post comment</button>
        </div>
        <div id="commentsList">${comments}</div>
        <h3 style="font-size:14px;font-weight:600;margin-top:12px">Activity</h3>
        <div class="timeline">${timeline}</div>
      </div>
      <div class="drawer-foot">
        <button type="button" class="btn-verify" id="drawerVerify" ${state.role !== 'alan' || t.state !== 'done_claimed' ? 'disabled' : ''} title="${state.role !== 'alan' ? 'Verify is available on Alan\'s login only' : ''}">Verify</button>
        <button type="button" class="btn-danger" id="drawerSendBack" ${state.role !== 'alan' || t.state !== 'done_claimed' ? 'disabled' : ''}>Send back with note</button>
        <button type="button" id="closeDrawer">Close</button>
        <p class="meta" style="width:100%">Verify is available on Alan's login only</p>
      </div>`;
    $('drawer').classList.add('open');
    $('backdrop').classList.add('open');
    $('drawer').setAttribute('aria-hidden', 'false');
    wireDrawer(t);
    hydrateCommentImages();
  }

  const pendingImages = [];

  function wireDrawer(t) {
    pendingImages.length = 0;
    $('closeDrawer').onclick = closeDrawer;
    $('drawerVerify').onclick = async () => {
      await api('/api/mc/actions', { method: 'POST', body: { action: 'verify', task_id: t.id } });
      await boot();
    };
    $('drawerSendBack').onclick = async () => {
      const note = prompt('Send-back note (required)');
      if (!note || !note.trim()) return alert('Note required');
      await api('/api/mc/actions', { method: 'POST', body: { action: 'send_back', task_id: t.id, note } });
      await boot();
    };
    $('saveEvidence').onclick = async () => {
      const evidence_url = $('evidenceInput').value.trim();
      await api('/api/mc/tasks', {
        method: 'PATCH',
        body: { id: t.id, evidence_url, state: 'done_claimed' },
      });
      await boot();
      openDrawer(t.id);
    };
    $('postComment').onclick = () => postComment(t.id);
    const box = $('commentBox');
    box.ondragover = (e) => e.preventDefault();
    box.ondrop = async (e) => {
      e.preventDefault();
      await addFiles(t.id, e.dataTransfer.files);
    };
    $('commentText').onpaste = async (e) => {
      const items = [...(e.clipboardData?.items || [])].filter((i) => i.type.startsWith('image/'));
      if (!items.length) return;
      e.preventDefault();
      const files = items.map((i) => i.getAsFile()).filter(Boolean);
      await addFiles(t.id, files);
    };
    $('drawer').querySelectorAll('[data-check]').forEach((el) => {
      el.onchange = async () => {
        await api('/api/mc/tasks', {
          method: 'POST',
          body: { action: 'checklist', checklist_id: el.getAttribute('data-check'), done: el.checked },
        });
        await boot();
        openDrawer(t.id);
      };
    });
  }

  async function addFiles(taskId, fileList) {
    for (const file of fileList) {
      const ext = (file.name.split('.').pop() || 'png').toLowerCase();
      const signed = await api('/api/mc/comments', {
        method: 'POST',
        body: { action: 'sign_upload', task_id: taskId, ext },
      });
      await fetch(signed.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      });
      pendingImages.push(signed.path);
      const img = document.createElement('img');
      img.src = URL.createObjectURL(file);
      img.alt = 'pending';
      $('pendingThumbs').appendChild(img);
    }
  }

  async function postComment(taskId) {
    const body_md = $('commentText').value.trim();
    if (!body_md) return;
    await api('/api/mc/comments', {
      method: 'POST',
      body: { task_id: taskId, body_md, image_urls: [...pendingImages] },
    });
    pendingImages.length = 0;
    await boot();
    openDrawer(taskId);
  }

  async function hydrateCommentImages() {
    for (const el of document.querySelectorAll('#commentsList .thumbs[data-paths]')) {
      const paths = (el.getAttribute('data-paths') || '').split(',').filter(Boolean);
      for (const path of paths) {
        try {
          const { url } = await api('/api/mc/comments', { method: 'POST', body: { action: 'sign_read', path } });
          if (!url) continue;
          const img = document.createElement('img');
          img.src = url;
          img.alt = 'attachment';
          img.onclick = () => {
            $('lightboxImg').src = url;
            $('lightbox').classList.add('open');
          };
          el.appendChild(img);
        } catch (e) { /* ignore */ }
      }
    }
  }

  function closeDrawer() {
    openTaskId = null;
    $('drawer').classList.remove('open');
    $('backdrop').classList.remove('open');
    $('drawer').setAttribute('aria-hidden', 'true');
  }

  function openModal() {
    const opts = state.projects.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
    $('modalBox').innerHTML = `
      <h2 style="font-size:16px;font-weight:600;margin-bottom:8px">New task</h2>
      <label>Title</label><input id="ntTitle"/>
      <label>Project</label><select id="ntProject">${opts}</select>
      <label>Owner</label><select id="ntOwner"><option>alan</option><option>claude</option><option>cursor</option><option>external</option></select>
      <label>Priority</label><select id="ntPriority"><option>p0</option><option selected>p1</option><option>p2</option></select>
      <label>Due</label><input id="ntDue" type="date"/>
      <label>Recurrence</label><input id="ntRec" placeholder="weekly:1 or monthly:1"/>
      <label>Next step</label><input id="ntNext"/>
      <label>Detail</label><textarea id="ntDetail" rows="3"></textarea>
      <div style="display:flex;gap:8px;margin-top:12px">
        <button type="button" id="ntSave">Create</button>
        <button type="button" id="ntCancel">Cancel</button>
      </div>`;
    $('modal').classList.add('open');
    $('ntCancel').onclick = () => $('modal').classList.remove('open');
    $('ntSave').onclick = async () => {
      await api('/api/mc/tasks', {
        method: 'POST',
        body: {
          title: $('ntTitle').value.trim(),
          project_id: $('ntProject').value,
          owner: $('ntOwner').value,
          priority: $('ntPriority').value,
          due_date: $('ntDue').value || null,
          recurrence: $('ntRec').value.trim() || null,
          next_step: $('ntNext').value.trim() || null,
          detail_md: $('ntDetail').value.trim() || null,
        },
      });
      $('modal').classList.remove('open');
      await boot();
    };
  }

  function jumpSearch(q) {
    const m = q.trim().match(/^MC-?(\d+)$/i);
    if (m) {
      const t = taskByMc(m[1]);
      if (t) {
        activeProjectId = t.project_id;
        setView('board');
        renderBoard();
        openDrawer(t.id);
        return;
      }
    }
    const hit = state.tasks.find((t) => t.title.toLowerCase().includes(q.toLowerCase()));
    if (hit) openDrawer(hit.id);
  }

  function setView(name) {
    document.querySelectorAll('.views').forEach((el) => el.classList.remove('active'));
    document.querySelectorAll('.view-btn').forEach((el) => el.classList.toggle('active', el.dataset.view === name));
    $(`view-${name}`).classList.add('active');
  }

  function wire() {
    $('loginBtn').onclick = login;
    $('pw').onkeydown = (e) => { if (e.key === 'Enter') login(); };
    $('logoutBtn').onclick = () => { clearSession(); location.reload(); };
    $('newTaskBtn').onclick = openModal;
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
      if (open) openDrawer(open.getAttribute('data-open'));
      const ver = e.target.closest('[data-verify]');
      if (ver) {
        await api('/api/mc/actions', { method: 'POST', body: { action: 'verify', task_id: ver.getAttribute('data-verify') } });
        await boot();
      }
      const proj = e.target.closest('[data-proj]');
      if (proj) {
        activeProjectId = proj.getAttribute('data-proj');
        renderBoard();
      }
    });
  }

  wire();
  if (token()) boot();
})();
