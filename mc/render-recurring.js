import { store } from './store.js';
import { $, esc, fmtTime, fmtDate } from './util.js';
import { nextDueFromRrule, lastDueOnOrBefore, RRULE_PRESETS } from './rrule.js';
import { api } from './api.js';
import { prioritySelectOptions } from './priority.js';
export const DIARY_HORIZON_DAYS = 28;

function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function wasOccurrenceSkipped(task, today) {
  try {
    const lastDue = lastDueOnOrBefore(task.rrule, today);
    if (!lastDue) return false;
    return (store.recurring_log || []).some(
      (l) => l.recurring_task_id === task.id
        && l.ideal_date === lastDue
        && String(l.change || '').startsWith('skipped occurrence'),
    );
  } catch (e) {
    return false;
  }
}

function statusFor(task) {
  if (!task.active) return { label: 'inactive', cls: '' };
  try {
    const today = todayStr();
    if (wasOccurrenceSkipped(task, today)) {
      return { label: 'skipped', cls: 'rec-skipped' };
    }
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
    <label>Priority<select id="${prefix}Pri">${prioritySelectOptions(t.priority || 'p1')}</select></label>
    <label>Ideal time<input id="${prefix}Time" type="time" value="${String(t.ideal_time || '09:00').slice(0, 5)}" /></label>
    <label>Window days (how far slot may drift from ideal)<input id="${prefix}Win" type="number" min="0" value="${t.window_days != null ? t.window_days : 2}" /></label>
    <label class="rec-toggle"><input id="${prefix}Crit" type="checkbox" ${t.time_critical ? 'checked' : ''} /> Time-critical (roll <strong>earlier</strong> if the ideal day is blocked, not later)</label>
    <label>Scheduled by Claude<input id="${prefix}Sched" value="${esc(t.scheduled_note || '')}" placeholder="Claude fills after booking diary — e.g. Thu 23 11:00–13:00" /></label>
    <label>Notes<textarea id="${prefix}Notes" rows="3">${esc(t.notes_md || '')}</textarea></label>
    <p class="meta">Claude books Google Calendar busy time <strong>${DIARY_HORIZON_DAYS} days ahead</strong> (not this app). Apps-dashboard never writes to Calendar.</p>`;
}

function formatScheduledCell(t) {
  if (!t.scheduled_note && !t.last_scheduled) return '<span class="meta">—</span>';
  const note = t.scheduled_note || fmtDate(t.last_scheduled);
  const rolled = /rolled from/i.test(String(note));
  const pill = rolled ? ' <span class="pill rec-rolled-pill">rolled</span>' : '';
  return `<span class="${rolled ? 'rec-sched rec-rolled' : 'rec-sched'}">${esc(note)}${pill}</span>`;
}

const DEP_TYPE_LABELS = {
  must_complete_first: 'must complete first',
  same_day_after: 'same day, after',
  within_hours: 'within hours',
};

function depsForHabit(habitId) {
  return (store.recurring_deps || []).filter((d) => d.habit_id === habitId);
}

function habitTitle(id) {
  const h = (store.recurring || []).find((r) => r.id === id);
  return h ? h.title : '(unknown habit)';
}

function depChip(d) {
  const suffix = d.dep_type === 'within_hours' ? ` ${d.within_hours}h` : '';
  const label = `${habitTitle(d.depends_on_habit_id)} — ${DEP_TYPE_LABELS[d.dep_type] || d.dep_type}${suffix}`;
  return `<span class="dep-chip">${esc(label)}<button type="button" class="dep-x" data-dep-remove="${d.id}" title="Remove dependency">×</button></span>`;
}

function depsCell(habitId) {
  const chips = depsForHabit(habitId).map(depChip).join('');
  return `<div class="dep-cell">${chips || '<span class="meta">—</span>'}
    <button type="button" class="btn-secondary dep-add-btn" data-dep-add="${habitId}">+ dep</button></div>`;
}

function otherHabitOptions(habitId) {
  return (store.recurring || [])
    .filter((h) => h.id !== habitId)
    .map((h) => `<option value="${esc(h.id)}">${esc(h.title)}</option>`)
    .join('');
}

function readForm(prefix) {
  return {
    title: $(`${prefix}Title`).value.trim(),
    cadence_text: $(`${prefix}Cadence`).value.trim(),
    rrule: $(`${prefix}Rrule`).value.trim(),
    duration_min: Number($(`${prefix}Dur`).value) || 60,
    priority: $(`${prefix}Pri`).value || 'p1',
    ideal_time: $(`${prefix}Time`).value || '09:00',
    window_days: Number($(`${prefix}Win`).value),
    time_critical: $(`${prefix}Crit`).checked,
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
      const skipped = st.label === 'skipped' ? '<span class="pill rec-skipped-pill">skipped</span>' : '';
      const crit = t.time_critical ? '<span class="pill rec-crit-pill" title="Rolls earlier (not later) when the ideal day is blocked">time-critical</span>' : '';
      const lastDone = t.last_done ? fmtDate(t.last_done) : '—';
      return `<tr class="${st.cls}">
      <td><strong>${esc(t.title)}</strong>${missed}${skipped}${crit}</td>
      <td>${esc(t.cadence_text)}</td>
      <td>${esc(t.priority || 'p1')}</td>
      <td>${t.duration_min} min</td>
      <td>${fmtTime(t.ideal_time)}</td>
      <td>${next}</td>
      <td>${lastDone}</td>
      <td>${formatScheduledCell(t)}</td>
      <td>${depsCell(t.id)}</td>
      <td><label class="rec-toggle"><input type="checkbox" data-rec-active="${t.id}" ${t.active ? 'checked' : ''} /> active</label></td>
      <td class="rec-actions">
        <button type="button" class="btn-secondary" data-rec-edit="${t.id}">Edit</button>
        <button type="button" class="btn-verify" data-rec-done="${t.id}">Mark done</button>
        <button type="button" class="btn-secondary" data-rec-skip="${t.id}">Skip</button>
      </td>
    </tr>`;
    }).join('')
    : '<tr><td colspan="11" class="meta">No habits yet — click <strong>Add habit</strong>.</td></tr>';

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
          <th>Title</th><th>Cadence</th><th>Priority</th><th>Duration</th><th>Ideal time</th><th>Next due</th><th>Last done</th>
          <th>Scheduled by Claude</th><th>Depends on</th><th>Active</th><th></th>
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

export function openRecurringEdit(id, onSave, occurrence = null) {
  const t = (store.recurring || []).find((r) => r.id === id);
  if (!t) return;
  const modal = $('modal');
  const box = $('modalBox');
  const occStart = occurrence
    ? String(occurrence.start_hm || occurrence.start || '09:00').slice(0, 5)
    : '';
  const occEnd = occurrence
    ? String(occurrence.end_hm || '').slice(0, 5)
    : '';
  const occDay = occurrence?.day || '';
  const occBlock = occurrence ? `
    <div class="inset" style="margin-bottom:12px">
      <h3 style="font-size:14px;margin:0 0 8px">This diary occurrence</h3>
      <p class="meta">Read the habit notes below, then set the slot for <strong>${esc(occDay)}</strong>.</p>
      <label>Date<input id="reOccDay" type="date" value="${esc(occDay)}" /></label>
      <label>Start<input id="reOccStart" type="time" value="${esc(occStart)}" /></label>
      <label>End<input id="reOccEnd" type="time" value="${esc(occEnd)}" /></label>
    </div>` : '';
  box.innerHTML = `<h2>Edit recurring habit</h2>
    ${occBlock}
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
    const dayEl = $('reOccDay');
    const startEl = $('reOccStart');
    const endEl = $('reOccEnd');
    if (dayEl && startEl && endEl && dayEl.value && startEl.value && endEl.value) {
      const newStart = `${dayEl.value}T${startEl.value}:00.000Z`;
      const newEnd = `${dayEl.value}T${endEl.value}:00.000Z`;
      await api('/api/mc/diary-action', {
        method: 'POST',
        body: {
          action: 'move',
          habit_id: t.id,
          title: t.title,
          ideal_date: occurrence?.ideal_date || dayEl.value,
          new_start: newStart,
          new_end: newEnd,
          override: true,
          calendar_event_id: occurrence?.calendar_event_id || undefined,
        },
      });
    }
    modal.classList.remove('open');
    if (onSave) await onSave();
  };
  modal.classList.add('open');
}

export function openDepEditor(habitId, onSave) {
  const modal = $('modal');
  const box = $('modalBox');
  box.innerHTML = `<h2>Add dependency</h2>
    <p class="meta"><strong>${esc(habitTitle(habitId))}</strong> depends on…</p>
    <label>Blocker habit<select id="depBlocker">${otherHabitOptions(habitId)}</select></label>
    <label>Type<select id="depType">
      <option value="must_complete_first">Must complete first</option>
      <option value="same_day_after">Same day, after</option>
      <option value="within_hours">Within N hours of blocker</option>
    </select></label>
    <label>Within hours (only for “within hours”)<input id="depHours" type="number" min="1" value="24" /></label>
    <label>Notes<input id="depNotes" placeholder="optional" /></label>
    <div style="display:flex;gap:8px;margin-top:12px">
      <button type="button" id="depSave" class="btn-verify">Add dependency</button>
      <button type="button" id="depCancel" class="btn-secondary">Cancel</button>
    </div>`;
  $('depCancel').onclick = () => modal.classList.remove('open');
  $('depSave').onclick = async () => {
    const depType = $('depType').value;
    const body = {
      habit_id: habitId,
      depends_on_habit_id: $('depBlocker').value,
      dep_type: depType,
      within_hours: depType === 'within_hours' ? Number($('depHours').value) : null,
      notes: $('depNotes').value.trim() || null,
    };
    try {
      await api('/api/mc/recurring-deps', { method: 'POST', body });
    } catch (err) {
      alert(err.message || 'Could not add dependency');
      return;
    }
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
  const depAdd = e.target.closest('[data-dep-add]');
  if (depAdd) {
    openDepEditor(depAdd.getAttribute('data-dep-add'), onSave);
    return true;
  }
  const depRemove = e.target.closest('[data-dep-remove]');
  if (depRemove) {
    await api('/api/mc/recurring-deps', {
      method: 'POST',
      body: { action: 'delete', id: depRemove.getAttribute('data-dep-remove') },
    });
    if (onSave) await onSave();
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
