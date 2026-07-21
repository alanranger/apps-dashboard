import { store } from './store.js';
import { $, esc, fmtTime, fmtDate } from './util.js';
import { nextDueFromRrule, lastDueOnOrBefore, RRULE_PRESETS } from './rrule.js';
import { api } from './api.js';

/** How far ahead Claude should book diary time (Alan-ruled). */
export const DIARY_HORIZON_DAYS = 28;

function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function statusFor(task) {
  if (!task.active) return { label: 'inactive', cls: '' };
  try {
    const today = todayStr();
    const lastDue = lastDueOnOrBefore(task.rrule, today);
    if (lastDue && (!task.last_done || task.last_done < lastDue) && lastDue < today) {
      return { label: 'missed', cls: 'rec-missed' };
    }
  } catch (e) { /* ignore bad rrule */ }
  return { label: 'ok', cls: '' };
}

function nextDue(task) {
  try {
    const from = task.last_done || todayStr();
    return nextDueFromRrule(task.rrule, from) || '—';
  } catch (e) {
    return '—';
  }
}

function presetOptions(selectedRrule) {
  return RRULE_PRESETS.map((p) =>
    `<option value="${esc(p.id)}" ${p.rrule === selectedRrule ? 'selected' : ''}>${esc(p.label)}</option>`,
  ).join('');
}

function wirePreset(prefix) {
  $(`${prefix}Preset`).onchange = (e) => {
    const p = RRULE_PRESETS.find((x) => x.id === e.target.value);
    if (p && p.id !== 'custom') {
      $(`${prefix}Rrule`).value = p.rrule;
      if (p.cadence) $(`${prefix}Cadence`).value = p.cadence;
    }
  };
}

function formFields(prefix, t = {}) {
  return `
    <label>Title<input id="${prefix}Title" value="${esc(t.title || '')}" placeholder="e.g. Backup Photos to Portable Drive" /></label>
    <label>Cadence (human)<input id="${prefix}Cadence" value="${esc(t.cadence_text || '')}" placeholder="Every Thursday" /></label>
    <label>Preset pattern<select id="${prefix}Preset">${presetOptions(t.rrule || '')}</select></label>
    <label>RRULE<input id="${prefix}Rrule" value="${esc(t.rrule || 'FREQ=WEEKLY;BYDAY=TH')}" /></label>
    <label>Duration (min)<input id="${prefix}Dur" type="number" min="5" value="${t.duration_min || 60}" /></label>
    <label>Ideal time<input id="${prefix}Time" type="time" value="${String(t.ideal_time || '09:00').slice(0, 5)}" /></label>
    <label>Window days (how far slot may drift from ideal)<input id="${prefix}Win" type="number" min="0" value="${t.window_days != null ? t.window_days : 2}" /></label>
    <label>Scheduled by Claude<input id="${prefix}Sched" value="${esc(t.scheduled_note || '')}" placeholder="Claude fills after booking diary — e.g. Thu 23 11:00–13:00" /></label>
    <label>Notes<textarea id="${prefix}Notes" rows="3">${esc(t.notes_md || '')}</textarea></label>
    <p class="meta">Claude books Google Calendar busy time <strong>${DIARY_HORIZON_DAYS} days ahead</strong> (not this app). Apps-dashboard never writes to Calendar.</p>`;
}

function readForm(prefix) {
  return {
    title: $(`${prefix}Title`).value.trim(),
    cadence_text: $(`${prefix}Cadence`).value.trim(),
    rrule: $(`${prefix}Rrule`).value.trim(),
    duration_min: Number($(`${prefix}Dur`).value) || 60,
    ideal_time: $(`${prefix}Time`).value || '09:00',
    window_days: Number($(`${prefix}Win`).value),
    scheduled_note: $(`${prefix}Sched`).value.trim() || null,
    notes_md: $(`${prefix}Notes`).value.trim() || null,
  };
}

export function renderRecurring() {
  const el = $('view-recurring');
  if (!el) return;
  const rows = store.recurring || [];

  const body = rows.length
    ? rows.map((t) => {
      const st = statusFor(t);
      const next = nextDue(t);
      const missed = st.label === 'missed' ? '<span class="pill rec-missed-pill">missed</span>' : '';
      const lastDone = t.last_done ? fmtDate(t.last_done) : '—';
      return `<tr class="${st.cls}">
      <td><strong>${esc(t.title)}</strong>${missed}</td>
      <td>${esc(t.cadence_text)}</td>
      <td>${t.duration_min} min</td>
      <td>${fmtTime(t.ideal_time)}</td>
      <td>${next}</td>
      <td>${lastDone}</td>
      <td class="rec-sched">${t.scheduled_note ? esc(t.scheduled_note) : '<span class="meta">—</span>'}</td>
      <td><label class="rec-toggle"><input type="checkbox" data-rec-active="${t.id}" ${t.active ? 'checked' : ''} /> active</label></td>
      <td class="rec-actions">
        <button type="button" class="btn-secondary" data-rec-edit="${t.id}">Edit</button>
        <button type="button" class="btn-verify" data-rec-done="${t.id}">Mark done</button>
        <button type="button" class="btn-secondary" data-rec-skip="${t.id}">Skip</button>
      </td>
    </tr>`;
    }).join('')
    : '<tr><td colspan="9" class="meta">No habits yet — click <strong>Add habit</strong>.</td></tr>';

  el.innerHTML = `<div class="card">
    <div class="rec-head">
      <div>
        <h2><i class="ti ti-repeat"></i> Recurring tasks (BAU)</h2>
        <p class="meta">Add habits here — not under New task. Claude books diary time <strong>${DIARY_HORIZON_DAYS} days ahead</strong>; this tab tracks cadence + done.</p>
      </div>
      <button type="button" class="btn-verify" id="recAddBtn" data-rec-add="1">+ Add habit</button>
    </div>
    <div class="rec-table-wrap">
      <table class="rec-table">
        <thead><tr>
          <th>Title</th><th>Cadence</th><th>Duration</th><th>Ideal time</th><th>Next due</th><th>Last done</th>
          <th>Scheduled by Claude</th><th>Active</th><th></th>
        </tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  </div>`;
}

export function openRecurringCreate(onSave) {
  const modal = $('modal');
  const box = $('modalBox');
  box.innerHTML = `<h2>Add recurring habit</h2>
    ${formFields('re')}
    <div style="display:flex;gap:8px;margin-top:12px">
      <button type="button" id="reSave" class="btn-verify">Create habit</button>
      <button type="button" id="reCancel" class="btn-secondary">Cancel</button>
    </div>`;
  wirePreset('re');
  $('reCancel').onclick = () => modal.classList.remove('open');
  $('reSave').onclick = async () => {
    const body = readForm('re');
    if (!body.title || !body.rrule || !body.cadence_text) {
      alert('Title, cadence, and RRULE are required.');
      return;
    }
    await api('/api/mc/recurring', { method: 'POST', body });
    modal.classList.remove('open');
    if (onSave) await onSave();
  };
  modal.classList.add('open');
}

export function openRecurringEdit(id, onSave) {
  const t = (store.recurring || []).find((r) => r.id === id);
  if (!t) return;
  const modal = $('modal');
  const box = $('modalBox');
  box.innerHTML = `<h2>Edit recurring habit</h2>
    ${formFields('re', t)}
    <div style="display:flex;gap:8px;margin-top:12px">
      <button type="button" id="reSave">Save</button>
      <button type="button" id="reCancel" class="btn-secondary">Cancel</button>
    </div>`;
  wirePreset('re');
  $('reCancel').onclick = () => modal.classList.remove('open');
  $('reSave').onclick = async () => {
    const body = readForm('re');
    await api('/api/mc/recurring', { method: 'PATCH', body: { id: t.id, ...body } });
    modal.classList.remove('open');
    if (onSave) await onSave();
  };
  modal.classList.add('open');
}

export async function handleRecurringClick(e, onSave) {
  if (e.target.closest('[data-rec-add]')) {
    openRecurringCreate(onSave);
    return true;
  }
  const edit = e.target.closest('[data-rec-edit]');
  if (edit) {
    openRecurringEdit(edit.getAttribute('data-rec-edit'), onSave);
    return true;
  }
  const done = e.target.closest('[data-rec-done]');
  if (done) {
    await api('/api/mc/recurring', {
      method: 'POST',
      body: { action: 'mark_done', id: done.getAttribute('data-rec-done') },
    });
    if (onSave) await onSave();
    return true;
  }
  const skip = e.target.closest('[data-rec-skip]');
  if (skip) {
    const reason = window.prompt('Skip this occurrence — optional reason (left blank is fine):', '') ?? null;
    if (reason === null) return true; // cancelled prompt
    await api('/api/mc/recurring', {
      method: 'POST',
      body: { action: 'skip', id: skip.getAttribute('data-rec-skip'), reason: reason || null },
    });
    if (onSave) await onSave();
    return true;
  }
  const active = e.target.closest('[data-rec-active]');
  if (active && e.target.matches('input[type=checkbox]')) {
    await api('/api/mc/recurring', {
      method: 'PATCH',
      body: { id: active.getAttribute('data-rec-active'), active: active.checked },
    });
    if (onSave) await onSave();
    return true;
  }
  return false;
}
