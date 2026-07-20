import { api } from './api.js';
import { store, taskById, commentsFor, logFor, checksFor } from './store.js';
import { STATE_LABEL, $, esc, fmtDate, handoffRef } from './util.js';
import { projectChip } from './render-board.js';

const pendingImages = [];

export function closeDrawer() {
  store.openTaskId = null;
  $('drawer').classList.remove('open');
  $('backdrop').classList.remove('open');
  $('drawer').setAttribute('aria-hidden', 'true');
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

async function postComment(taskId, onRefresh) {
  const body_md = $('commentText').value.trim();
  if (!body_md) return;
  await api('/api/mc/comments', {
    method: 'POST',
    body: { task_id: taskId, body_md, image_urls: [...pendingImages] },
  });
  pendingImages.length = 0;
  await onRefresh();
  await openDrawer(taskId, onRefresh);
}

function wireDrawer(t, onRefresh) {
  pendingImages.length = 0;
  $('closeDrawer').onclick = closeDrawer;
  $('drawerVerify').onclick = async () => {
    await api('/api/mc/actions', { method: 'POST', body: { action: 'verify', task_id: t.id } });
    await onRefresh();
  };
  $('drawerSendBack').onclick = async () => {
    const note = prompt('Send-back note (required)');
    if (!note || !note.trim()) return alert('Note required');
    await api('/api/mc/actions', { method: 'POST', body: { action: 'send_back', task_id: t.id, note } });
    await onRefresh();
  };
  $('saveEvidence').onclick = async () => {
    const evidence_url = $('evidenceInput').value.trim();
    await api('/api/mc/tasks', {
      method: 'PATCH',
      body: { id: t.id, evidence_url, state: 'done_claimed' },
    });
    await onRefresh();
    await openDrawer(t.id, onRefresh);
  };
  $('postComment').onclick = () => postComment(t.id, onRefresh);
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
    await addFiles(t.id, items.map((i) => i.getAsFile()).filter(Boolean));
  };
  $('drawer').querySelectorAll('[data-check]').forEach((el) => {
    el.onchange = async () => {
      await api('/api/mc/tasks', {
        method: 'POST',
        body: { action: 'checklist', checklist_id: el.getAttribute('data-check'), done: el.checked },
      });
      await onRefresh();
      await openDrawer(t.id, onRefresh);
    };
  });
}

export async function openDrawer(taskId, onRefresh) {
  const t = taskById(taskId);
  if (!t) return;
  store.openTaskId = taskId;

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
      <button type="button" class="btn-verify" id="drawerVerify" ${store.role !== 'alan' || t.state !== 'done_claimed' ? 'disabled' : ''} title="${store.role !== 'alan' ? 'Verify is available on Alan\'s login only' : ''}">Verify</button>
      <button type="button" class="btn-danger" id="drawerSendBack" ${store.role !== 'alan' || t.state !== 'done_claimed' ? 'disabled' : ''}>Send back with note</button>
      <button type="button" id="closeDrawer">Close</button>
      <p class="meta" style="width:100%">Verify is available on Alan's login only</p>
    </div>`;

  $('drawer').classList.add('open');
  $('backdrop').classList.add('open');
  $('drawer').setAttribute('aria-hidden', 'false');
  wireDrawer(t, onRefresh);
  await hydrateCommentImages();
}
