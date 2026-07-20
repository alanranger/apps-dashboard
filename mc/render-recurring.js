import { store } from './store.js';
import { $, esc, fmtTime } from './util.js';
import { nextDueFromRrule, lastDueOnOrBefore, RRULE_PRESETS } from './rrule.js';
import { api } from './api.js';

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function statusFor(task) {
  if (!task.active) return { label: 'inactive', cls: '' };
  const today = todayStr();
  const lastDue = lastDueOnOrBefore(task.rrule, today);
  if (lastDue && (!task.last_done || task.last_done < lastDue) && lastDue < today) {
    return { label: 'missed', cls: 'rec-missed' };
  }
  return { label: 'ok', cls: '' };
}

function nextDue(task) {
  const from = task.last_done || todayStr();
  return nextDueFromRrule(task.rrule, from) || '—';
}

export function renderRecurring() {
  const el = $('view-recurring');
  if (!el) return;
  const rows = store.recurring || [];
  if (!rows.length) {
    el.innerHTML = `<div class="card"><div class="empty"><i class="ti ti-repeat"></i>No recurring tasks yet. Run sql/004_recurring_tasks.sql in Supabase.</div></div>`;
    return;
  }

  const body = rows.map((t) => {
    const st = statusFor(t);
    const next = nextDue(t);
    const missed = st.label === 'missed' ? '<span class="pill rec-missed-pill">missed</span>' : '';
    return `<tr class="${st.cls}">
      <td><strong>${esc(t.title)}</strong>${missed}</td>
      <td>${esc(t.cadence_text)}</td>
      <td>${t.duration_min} min</td>
      <td>${fmtTime(t.ideal_time)}</td>
      <td>${next}</td>
      <td class="rec-sched">${t.scheduled_note ? esc(t.scheduled_note) : '<span class="meta">—</span>'}</td>
      <td><label class="rec-toggle"><input type="checkbox" data-rec-active="${t.id}" ${t.active ? 'checked' : ''} /> active</label></td>
      <td class="rec-actions">
        <button type="button" class="btn-secondary" data-rec-edit="${t.id}">Edit</button>
        <button type="button" class="btn-verify" data-rec-done="${t.id}">Mark done</button>
      </td>
    </tr>`;
  }).join('');

  el.innerHTML = `<div class="card">
    <h2><i class="ti ti-repeat"></i> Recurring tasks</h2>
    <p class="meta" style="margin-bottom:12px">Habits from Reclaim — Claude schedules slots in Google Calendar; this tab tracks cadence and completion only (no calendar writes).</p>
    <div class="rec-table-wrap">
      <table class="rec-table">
        <thead><tr>
          <th>Title</th><th>Cadence</th><th>Duration</th><th>Ideal time</th><th>Next due</th>
          <th>Scheduled by Claude</th><th>Active</th><th></th>
        </tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  </div>`;
}

export function openRecurringEdit(id, onSave) {
  const t = (store.recurring || []).find((r) => r.id === id);
  if (!t) return;
  const modal = $('modal');
  const box = $('modalBox');
  const presets = RRULE_PRESETS.map((p) =>
    `<option value="${esc(p.id)}" ${p.rrule === t.rrule ? 'selected' : ''}>${esc(p.label)}</option>`,
  ).join('');

  box.innerHTML = `<h2>Edit recurring</h2>
    <label>Title<input id="reTitle" value="${esc(t.title)}" /></label>
    <label>Cadence (human)<input id="reCadence" value="${esc(t.cadence_text)}" /></label>
    <label>Preset pattern<select id="rePreset">${presets}</select></label>
    <label>RRULE<input id="reRrule" value="${esc(t.rrule)}" /></label>
    <label>Duration (min)<input id="reDur" type="number" min="5" value="${t.duration_min}" /></label>
    <label>Ideal time<input id="reTime" type="time" value="${String(t.ideal_time).slice(0, 5)}" /></label>
    <label>Window days<input id="reWin" type="number" min="0" value="${t.window_days}" /></label>
    <label>Scheduled by Claude (read-only note)<input id="reSched" value="${esc(t.scheduled_note || '')}" placeholder="Thu 23 11:00–13:00" /></label>
    <label>Notes<textarea id="reNotes" rows="3">${esc(t.notes_md || '')}</textarea></label>
    <div style="display:flex;gap:8px;margin-top:12px">
      <button type="button" id="reSave">Save</button>
      <button type="button" id="reCancel" class="btn-secondary">Cancel</button>
    </div>`;

  $('rePreset').onchange = (e) => {
    const p = RRULE_PRESETS.find((x) => x.id === e.target.value);
    if (p && p.id !== 'custom') {
      $('reRrule').value = p.rrule;
      if (p.cadence) $('reCadence').value = p.cadence;
    }
  };

  $('reCancel').onclick = () => modal.classList.remove('open');
  $('reSave').onclick = async () => {
    await api('/api/mc/recurring', {
      method: 'PATCH',
      body: {
        id: t.id,
        title: $('reTitle').value.trim(),
        cadence_text: $('reCadence').value.trim(),
        rrule: $('reRrule').value.trim(),
        duration_min: Number($('reDur').value) || 60,
        ideal_time: $('reTime').value || '09:00',
        window_days: Number($('reWin').value),
        scheduled_note: $('reSched').value.trim() || null,
        notes_md: $('reNotes').value.trim() || null,
      },
    });
    modal.classList.remove('open');
    if (onSave) await onSave();
  };

  modal.classList.add('open');
}

export async function handleRecurringClick(e, onSave) {
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
