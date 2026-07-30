import { store } from './store.js';
import { $, esc, fmtTime, fmtDate } from './util.js';
import { nextDueFromRrule, lastDueOnOrBefore, occurrencesInRange, RRULE_PRESETS } from './rrule.js';
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
      // Pin / skip for that ideal clears missed. Future Diary placements also
      // mean the placer caught up — don't red-flag just because last_done is null.
      const lastSt = occurrenceStatus(task, lastDue);
      if (lastSt.kind === 'pinned' || lastSt.kind === 'done' || lastSt.kind === 'skipped') {
        return { label: 'ok', cls: '' };
      }
      const upcoming = upcomingIdeals(task, 4);
      if (upcoming.some((d) => occurrenceStatus(task, d).kind === 'pinned')) {
        return { label: 'ok', cls: '' };
      }
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

function matchPresetId(rrule) {
  const r = String(rrule || '');
  const exact = RRULE_PRESETS.find((p) => p.rrule === r);
  if (exact) return exact.id;
  if (/FREQ=MONTHLY;INTERVAL=3;BYDAY=/i.test(r)) return 'quarterly-nth';
  if (/FREQ=MONTHLY;INTERVAL=2;BYDAY=/i.test(r)) return 'monthly-nth-bi';
  if (/FREQ=MONTHLY;BYDAY=/i.test(r)) return 'monthly-nth';
  if (/FREQ=MONTHLY;BYMONTHDAY=/i.test(r)) return 'monthly-dom';
  if (/FREQ=WEEKLY/i.test(r)) return 'weekly';
  return 'custom';
}

function presetOptions(selectedRrule) {
  const sel = matchPresetId(selectedRrule);
  return RRULE_PRESETS.map((p) =>
    `<option value="${esc(p.id)}" ${p.id === sel ? 'selected' : ''}>${esc(p.label)}</option>`,
  ).join('');
}

/** London wall-clock ymd+HH:MM → ISO (same correction as diary). */
function londonYmdHmToIso(ymd, hm) {
  const want = Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
  let t = Date.parse(`${ymd}T${hm}:00.000Z`);
  for (let i = 0; i < 48; i += 1) {
    const d = new Date(t);
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d);
    const get = (type) => parts.find((p) => p.type === type)?.value;
    const day = `${get('year')}-${get('month')}-${get('day')}`;
    const got = Number(get('hour')) * 60 + Number(get('minute'));
    if (day !== ymd) {
      t += (ymd > day ? 1 : -1) * 3600000;
      continue;
    }
    if (got === want) return d.toISOString();
    t += (want - got) * 60000;
  }
  return `${ymd}T${hm}:00.000Z`;
}

function fmtOccDay(ymd) {
  if (!ymd) return '—';
  const d = new Date(`${ymd}T12:00:00Z`);
  return d.toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
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
    <label class="rec-toggle"><input id="${prefix}Crit" type="checkbox" ${t.time_critical ? 'checked' : ''} /> Time-critical (deadline: roll <strong>earlier</strong>; month-day / 1MO anchors always roll <strong>forward</strong> only)</label>
    <label>Legacy note (optional)<input id="${prefix}Sched" value="${esc(t.scheduled_note || '')}" placeholder="Ignored by Occurrences column — diary log is truth" /></label>
    <label>Notes<textarea id="${prefix}Notes" rows="3">${esc(t.notes_md || '')}</textarea></label>
    <p class="meta">Occurrences on this tab come from <strong>recurring_log</strong> (placer / Diary drag / skip). Push writes Google; this tab never invents a pin.</p>`;
}

function addDaysYmd(ymd, n) {
  const d = new Date(`${ymd}T12:00:00`);
  d.setDate(d.getDate() + n);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function londonHmFromIso(iso) {
  if (!iso || !String(iso).includes('T')) return '';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(iso));
  } catch (_) {
    return String(iso).slice(11, 16);
  }
}

function latestLogForIdeal(habitId, idealYmd) {
  const rows = (store.recurring_log || []).filter(
    (l) => l.recurring_task_id === habitId && l.ideal_date === idealYmd,
  );
  return rows[0] || null;
}

/** Truth for one ideal due date — from recurring_log, not stale scheduled_note. */
function occurrenceStatus(task, idealYmd) {
  if (task.last_done && task.last_done >= idealYmd) {
    return { kind: 'done', text: `${idealYmd} · done` };
  }
  const log = latestLogForIdeal(task.id, idealYmd);
  if (!log) {
    return { kind: 'open', text: `${idealYmd} · not attempted yet` };
  }
  const ch = String(log.change || '');
  if (/^skipped/i.test(ch)) {
    return { kind: 'skipped', text: `${idealYmd} · skipped` };
  }
  if (/^unplaced/i.test(ch)) {
    return { kind: 'unplaced', text: `${idealYmd} · NOT in diary (waiting for placer)` };
  }
  if (/^diary_pin:/i.test(ch)) {
    const m = ch.match(/^diary_pin:([^|]+)\|/);
    const day = log.scheduled_date || idealYmd;
    const hm = londonHmFromIso(m?.[1]);
    const rolled = day !== idealYmd ? ` (ideal ${idealYmd})` : '';
    const gcal = log.calendar_event_id ? ' · on Google' : ' · DB only (Push?)';
    return { kind: 'pinned', text: `${day}${hm ? ` ${hm}` : ''}${rolled}${gcal}` };
  }
  return { kind: 'other', text: `${idealYmd} · ${ch.slice(0, 48)}` };
}

function upcomingIdeals(task, count = 4) {
  const today = todayStr();
  // Anchor from a real prior due so WEEKLY INTERVAL=8 does not invent every Monday.
  let from = today;
  try {
    const last = lastDueOnOrBefore(task.rrule, addDaysYmd(today, -1));
    if (last) from = last;
  } catch (_) { /* ignore */ }
  const to = addDaysYmd(today, 180);
  try {
    const all = occurrencesInRange(task.rrule, from, to);
    const upcoming = all.filter((d) => d >= today);
    return (upcoming.length ? upcoming : all).slice(0, count);
  } catch (_) {
    const n = nextDue(task);
    return n && n !== '—' ? [n] : [];
  }
}

function formatScheduledCell(t) {
  const ideals = upcomingIdeals(t, 4);
  if (!ideals.length) {
    return '<span class="meta">No upcoming dates from cadence</span>';
  }
  const lines = ideals.map((ideal) => {
    const st = occurrenceStatus(t, ideal);
    return `<li class="rec-occ rec-occ-${esc(st.kind)}">${esc(st.text)}</li>`;
  }).join('');
  return `<ul class="rec-occ-list" title="From recurring_log — not the old Scheduled note">${lines}</ul>`;
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
      const crit = t.time_critical ? '<span class="pill rec-crit-pill" title="Deadline: earlier; BYMONTHDAY/1MO: forward only">time-critical</span>' : '';
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
        <p class="meta">Cadence + done live here. <strong>Occurrences</strong> column shows the next dates from the diary log (in Diary / not placed / skipped) — not a stale sticky note.</p>
      </div>
      <button type="button" class="btn-verify" id="recAddBtn" data-rec-add="1">+ Add habit</button>
    </div>
    <div class="rec-table-wrap">
      <table class="rec-table">
        <thead><tr>
          <th>Title</th><th>Cadence</th><th>Priority</th><th>Duration</th><th>Ideal time</th><th>Next due</th><th>Last done</th>
          <th>Occurrences (diary truth)</th><th>Depends on</th><th>Active</th><th></th>
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
  const idealDay = occurrence?.ideal_date || occDay;
  const occBlock = occurrence ? `
    <div class="inset" style="margin-bottom:12px;border:1px solid #3b82f6;padding:10px;border-radius:8px">
      <h3 style="font-size:14px;margin:0 0 8px">Move this diary occurrence</h3>
      <p class="meta" style="margin:0 0 8px">
        RRULE ideal: <strong>${esc(fmtOccDay(idealDay))}</strong>
        ${idealDay !== occDay ? ` · currently on <strong>${esc(fmtOccDay(occDay))}</strong> (manual pin)` : ''}
      </p>
      <p class="meta" style="margin:0 0 8px">
        Drag only works inside the week you’re viewing. Change <strong>Date</strong> here to move across weeks, then Save.
      </p>
      <label>Date (this occurrence)<input id="reOccDay" type="date" value="${esc(occDay)}" /></label>
      <label>Start<input id="reOccStart" type="time" value="${esc(occStart)}" /></label>
      <label>End<input id="reOccEnd" type="time" value="${esc(occEnd)}" /></label>
    </div>` : '';
  box.innerHTML = `<h2>Edit recurring habit</h2>
    ${occBlock}
    ${formFields('re', t)}
    <div style="display:flex;gap:8px;margin-top:12px">
      <button type="button" id="reSave">${occurrence ? 'Save habit + move occurrence' : 'Save'}</button>
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
      await api('/api/mc/diary-action', {
        method: 'POST',
        body: {
          action: 'move',
          habit_id: t.id,
          title: t.title,
          ideal_date: idealDay,
          new_start: londonYmdHmToIso(dayEl.value, startEl.value),
          new_end: londonYmdHmToIso(dayEl.value, endEl.value),
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
