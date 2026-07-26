import { api } from './api.js';
import { store, taskById, commentsFor, logFor, checksFor } from './store.js';
import { STATE_LABEL, $, esc, fmtDate, handoffRef } from './util.js';
import { projectChip } from './render-board.js';
import { prioritySelectOptions } from './priority.js';

const pendingImages = [];

/** Browser-local datetime-local value from ISO (Alan's machine = London). */
function toDatetimeLocal(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromDatetimeLocal(v) {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

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
  const files = [...fileList].filter((f) => f && f.type && f.type.startsWith('image/'));
  if (!files.length) {
    alert('Please choose an image file (PNG, JPG, WebP, GIF).');
    return;
  }
  for (const file of files) {
    try {
      const ext = (file.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
      const signed = await api('/api/mc/comments', {
        method: 'POST',
        body: { action: 'sign_upload', task_id: taskId, ext },
      });
      const up = await fetch(signed.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      });
      if (!up.ok) throw new Error(`Upload failed (${up.status})`);
      pendingImages.push(signed.path);
      const img = document.createElement('img');
      img.src = URL.createObjectURL(file);
      img.alt = 'pending screenshot';
      $('pendingThumbs').appendChild(img);
      const status = $('attachStatus');
      if (status) status.textContent = `${pendingImages.length} screenshot(s) ready — click Post note`;
    } catch (e) {
      alert(e.message || 'Screenshot upload failed');
    }
  }
}

async function postNote(taskId, onRefresh) {
  const body_md = $('commentText').value.trim();
  if (!body_md && !pendingImages.length) {
    alert('Type a note and/or add a screenshot, then click Post note.');
    return;
  }
  try {
    await api('/api/mc/comments', {
      method: 'POST',
      body: {
        task_id: taskId,
        body_md: body_md || '(screenshot reply)',
        image_urls: [...pendingImages],
        actor: 'alan',
      },
    });
    pendingImages.length = 0;
    const due = $('dueInput')?.value;
    const next = $('nextStepInput')?.value?.trim();
    const patch = { id: taskId };
    if (due) patch.due_date = due;
    if (next !== undefined && $('nextStepInput')) patch.next_step = next || null;
    if (due || $('nextStepInput')) {
      await api('/api/mc/tasks', { method: 'PATCH', body: patch });
    }
    await onRefresh();
    await openDrawer(taskId, onRefresh);
  } catch (e) {
    alert(e.message || 'Could not save note');
  }
}

function wireDrawer(t, onRefresh) {
  pendingImages.length = 0;
  $('closeDrawer').onclick = closeDrawer;

  const verifyBtn = $('drawerVerify');
  if (verifyBtn) {
    verifyBtn.onclick = async () => {
      try {
        await api('/api/mc/actions', { method: 'POST', body: { action: 'verify', task_id: t.id } });
        await onRefresh();
        closeDrawer();
      } catch (e) {
        alert(e.message || 'Verify failed');
      }
    };
  }

  const sendBackBtn = $('drawerSendBack');
  if (sendBackBtn) {
    sendBackBtn.onclick = async () => {
      const fromBox = $('commentText')?.value?.trim();
      const note = fromBox || prompt('Send-back note (required)');
      if (!note || !note.trim()) {
        alert('Send back needs a note. Type it in the note box, then click Send back.');
        return;
      }
      try {
        await api('/api/mc/actions', { method: 'POST', body: { action: 'send_back', task_id: t.id, note } });
        await onRefresh();
        closeDrawer();
      } catch (e) {
        alert(e.message || 'Send back failed');
      }
    };
  }

  const unpinBtn = $('unpinSlot');
  if (unpinBtn) {
    unpinBtn.onclick = async () => {
      try {
        await api('/api/mc/tasks', { method: 'PATCH', body: { id: t.id, slot_pinned: false } });
        await onRefresh();
        await openDrawer(t.id, onRefresh);
      } catch (e) {
        alert(e.message || 'Unpin failed');
      }
    };
  }

  $('saveDetails').onclick = async () => {
    try {
      let estMinutes = null;
      const estRaw = $('estInput')?.value;
      if (estRaw != null && String(estRaw).trim() !== '') {
        const parsed = Number.parseInt(estRaw, 10);
        estMinutes = Number.isNaN(parsed) ? null : parsed;
      }
      await api('/api/mc/tasks', {
        method: 'PATCH',
        body: {
          id: t.id,
          due_date: $('dueInput').value || null,
          est_minutes: estMinutes,
          next_step: $('nextStepInput').value.trim() || null,
          priority: $('priorityInput')?.value || t.priority,
          impact: $('impactInput')?.value || t.impact || 'MEDIUM',
          difficulty: $('difficultyInput')?.value || t.difficulty || 'MEDIUM',
          waiting_on: $('waitingInput')?.value.trim() || null,
          why: $('whyInput')?.value.trim() || null,
          detail_md: $('detailInput')?.value.trim() || null,
        },
      });
      const newStart = fromDatetimeLocal($('schedStartInput')?.value);
      const newEnd = fromDatetimeLocal($('schedEndInput')?.value);
      const startChanged = newStart && newStart !== t.scheduled_start;
      const endChanged = newEnd && newEnd !== t.scheduled_end;
      if (newStart && newEnd && (startChanged || endChanged)) {
        await api('/api/mc/diary-action', {
          method: 'POST',
          body: {
            action: 'move',
            task_id: t.id,
            title: t.title,
            new_start: newStart,
            new_end: newEnd,
            override: true,
            calendar_event_id: t.calendar_event_id || undefined,
          },
        });
      }
      await onRefresh();
      await openDrawer(t.id, onRefresh);
    } catch (e) {
      alert(e.message || 'Could not save details');
    }
  };

  $('saveEvidence').onclick = async () => {
    try {
      const evidence_url = $('evidenceInput').value.trim();
      await api('/api/mc/tasks', {
        method: 'PATCH',
        body: { id: t.id, evidence_url, state: 'done_claimed' },
      });
      await onRefresh();
      await openDrawer(t.id, onRefresh);
    } catch (e) {
      alert(e.message || 'Could not save evidence');
    }
  };

  $('postComment').onclick = () => postNote(t.id, onRefresh);
  const box = $('commentBox');
  const fileInput = $('screenshotInput');
  $('attachScreenshot').onclick = () => fileInput.click();
  fileInput.onchange = async () => {
    if (fileInput.files?.length) await addFiles(t.id, fileInput.files);
    fileInput.value = '';
  };
  box.ondragover = (e) => {
    e.preventDefault();
    box.classList.add('drop-active');
  };
  box.ondragleave = () => box.classList.remove('drop-active');
  box.ondrop = async (e) => {
    e.preventDefault();
    box.classList.remove('drop-active');
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

function footerHtml(t) {
  if (store.role === 'alan' && t.state === 'done_claimed') {
    return `
      <div class="drawer-foot">
        <button type="button" class="btn-verify" id="drawerVerify">Verify</button>
        <button type="button" class="btn-danger" id="drawerSendBack">Send back with note</button>
        <button type="button" id="closeDrawer">Close</button>
        <p class="meta" style="width:100%">Send back uses the note box above (or asks for a note).</p>
      </div>`;
  }
  return `
    <div class="drawer-foot">
      <button type="button" id="closeDrawer">Close</button>
      <p class="meta" style="width:100%">To leave a note: type above → Post note. Verify / Send back only appear when a task is done-claimed.</p>
    </div>`;
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
    </div>`).join('') || '<p class="meta">No notes yet.</p>';

  const timeline = logFor(taskId).map((l) => `
    <div class="item"><strong>${esc(l.actor)}</strong> · ${fmtDate(l.at)}<br>${esc(l.change)}</div>`).join('')
    || '<div class="item">No activity yet.</div>';

  $('drawer').innerHTML = `
    <div class="drawer-body">
      <div class="meta">MC-${t.display_id}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin:8px 0">${projectChip(t)}<span class="chip">${esc(STATE_LABEL[t.state])}</span></div>
      <h2 style="font-size:16px;font-weight:600">${esc(t.title)}</h2>
      <p class="meta">${esc(t.owner)} · ${esc(t.priority || 'p1')}${t.claimed_by ? ` · claimed by ${esc(t.claimed_by)}` : ''}${t.close_authorized_by ? ` · closed by ${esc(t.close_authorized_by)}` : ''}${t.slot_pinned ? ` · <span class="chip pinned">📌 pinned ${fmtDate(t.slot_pinned_at)}</span>` : ''}${t.completed_on ? ` · completed ${esc(t.completed_on)}` : ''}</p>
      ${t.slot_pinned ? `<div class="inset"><p class="meta">Work block pinned — auto-scheduling skips this task.</p><button type="button" id="unpinSlot">Unpin / allow rescheduling</button></div>` : ''}
      ${t.close_reason ? `<div class="inset"><div class="meta">Close reason</div><p>${esc(t.close_reason)}</p>${t.superseded_by_display_id ? `<p class="meta">Superseded by MC-${t.superseded_by_display_id}</p>` : ''}${t.close_authorized_at ? `<p class="meta">${fmtDate(t.close_authorized_at)}</p>` : ''}</div>` : ''}

      <div class="inset">
        <div class="meta">What this is about</div>
        <textarea id="detailInput" rows="8" placeholder="Description: what / why / done when…" style="width:100%;padding:8px;margin:4px 0 8px;white-space:pre-wrap">${esc(t.detail_md || '')}</textarea>
        <label class="meta" for="priorityInput">Priority (ops)</label>
        <select id="priorityInput" style="width:100%;padding:8px;margin:4px 0 8px">
          ${prioritySelectOptions(t.priority || 'p1')}
        </select>
        <label class="meta" for="impactInput">Impact (matrix)</label>
        <select id="impactInput" style="width:100%;padding:8px;margin:4px 0 8px" title="Business impact for the priority matrix">
          ${['HIGH', 'MEDIUM', 'LOW'].map((v) => `<option value="${v}" ${(t.impact || 'MEDIUM') === v ? 'selected' : ''}>${v}</option>`).join('')}
        </select>
        <label class="meta" for="difficultyInput">Difficulty (matrix)</label>
        <select id="difficultyInput" style="width:100%;padding:8px;margin:4px 0 8px" title="Effort / difficulty for the priority matrix">
          ${['LOW', 'MEDIUM', 'HIGH'].map((v) => `<option value="${v}" ${(t.difficulty || 'MEDIUM') === v ? 'selected' : ''}>${v}</option>`).join('')}
        </select>
        <label class="meta" for="dueInput">Due date</label>
        <input id="dueInput" type="date" value="${esc(t.due_date || '')}" style="width:100%;padding:8px;margin:4px 0 8px"/>
        <label class="meta" for="schedStartInput">Diary slot start</label>
        <input id="schedStartInput" type="datetime-local" value="${esc(toDatetimeLocal(t.scheduled_start))}" style="width:100%;padding:8px;margin:4px 0 8px"/>
        <label class="meta" for="schedEndInput">Diary slot end</label>
        <input id="schedEndInput" type="datetime-local" value="${esc(toDatetimeLocal(t.scheduled_end))}" style="width:100%;padding:8px;margin:4px 0 8px"/>
        <p class="meta">Changing the diary slot pins the block and queues a GCal push (due date is unchanged).</p>
        <label class="meta" for="estInput">Estimate (mins)</label>
        <input id="estInput" type="number" min="0" step="5" inputmode="numeric" value="${t.est_minutes ?? ''}" placeholder="e.g. 90" style="width:100%;padding:8px;margin:4px 0 8px"/>
        <label class="meta" for="whyInput">Why (one line — what it unblocks or costs)</label>
        <input id="whyInput" value="${esc(t.why || '')}" placeholder="Unblocks X / costs Y if delayed" style="width:100%;padding:8px;margin:4px 0 8px"/>
        <label class="meta" for="nextStepInput">Next step</label>
        <input id="nextStepInput" value="${esc(t.next_step || '')}" placeholder="What happens next" style="width:100%;padding:8px;margin:4px 0 8px"/>
        <label class="meta" for="waitingInput">Waiting on</label>
        <input id="waitingInput" value="${esc(t.waiting_on || '')}" placeholder="Person / blocker (if any)" style="width:100%;padding:8px;margin:4px 0 8px"/>
        <button type="button" id="saveDetails">Save description / dates / priority</button>
      </div>

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
      <h3 style="font-size:14px;font-weight:600;margin-top:12px">Your reply (Claude + Cursor both read this)</h3>
      <p class="meta">Whoever owns the task (claude / cursor / you) must read notes and screenshots before working.</p>
      <div id="commentBox" class="inset drop-zone">
        <textarea id="commentText" rows="4" placeholder="Type your note… or paste a screenshot (Ctrl+V)…" style="width:100%;padding:8px"></textarea>
        <div class="attach-row">
          <button type="button" id="attachScreenshot">Add screenshot</button>
          <input id="screenshotInput" type="file" accept="image/*" multiple hidden />
          <span class="meta" id="attachStatus">Or drag-drop / paste image here</span>
        </div>
        <div id="pendingThumbs" class="thumbs"></div>
        <button type="button" id="postComment" class="btn-verify" style="margin-top:8px">Post note</button>
      </div>
      <div id="commentsList">${comments}</div>
      <h3 style="font-size:14px;font-weight:600;margin-top:12px">Activity</h3>
      <div class="timeline">${timeline}</div>
    </div>
    ${footerHtml(t)}`;

  $('drawer').classList.add('open');
  $('backdrop').classList.add('open');
  $('drawer').setAttribute('aria-hidden', 'false');
  wireDrawer(t, onRefresh);
  await hydrateCommentImages();
}
