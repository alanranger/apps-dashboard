import { store } from './store.js';
import { $, esc, fmtTime, fmtDate } from './util.js';
import {
  nextDueFromRrule, lastDueOnOrBefore, idealsInHorizon,
  parseBuilder, buildRrule, humanCadence, setPhaseStart, dowCodeFromYmd,
  CADENCE_PATTERNS, DOW_NAME, DOW_CODE,
} from './rrule.js';
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

function addMinutesHm(hm, mins) {
  const [h, m] = String(hm || '09:00').slice(0, 5).split(':').map(Number);
  const total = ((h * 60 + m) + Number(mins || 0) + 24 * 60) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function patternOptions(selected) {
  return CADENCE_PATTERNS.map((p) =>
    `<option value="${esc(p.id)}" ${p.id === selected ? 'selected' : ''}>${esc(p.label)}</option>`,
  ).join('');
}

function dowOptions(selected) {
  return DOW_CODE.map((c) =>
    `<option value="${c}" ${c === selected ? 'selected' : ''}>${esc(DOW_NAME[c])}</option>`,
  ).join('');
}

function nthOptions(selected) {
  return [1, 2, 3, 4, -1].map((n) => {
    const label = n === -1 ? 'Last' : `${n}${n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'}`;
    return `<option value="${n}" ${Number(selected) === n ? 'selected' : ''}>${label}</option>`;
  }).join('');
}

function formFields(prefix, t = {}) {
  const b = parseBuilder(t.rrule || 'FREQ=WEEKLY;BYDAY=TH');
  return `
    <label>Title<input id="${prefix}Title" value="${esc(t.title || '')}" placeholder="e.g. Backup Photos to Portable Drive" /></label>
    <div class="rec-builder">
      <label>Pattern<select id="${prefix}Pattern">${patternOptions(b.pattern)}</select></label>
      <label>Every N<input id="${prefix}Interval" type="number" min="1" value="${b.interval}" title="Weeks or months depending on pattern" /></label>
      <label class="rec-bld-dow">Weekday<select id="${prefix}Byday">${dowOptions(b.byday)}</select></label>
      <label class="rec-bld-nth">Nth<select id="${prefix}Nth">${nthOptions(b.nth)}</select></label>
      <label class="rec-bld-dom">Day of month<input id="${prefix}Monthday" type="number" min="1" max="31" value="${b.monthday}" /></label>
      <label class="rec-bld-custom">Custom RRULE<input id="${prefix}CustomRrule" value="${esc(b.customRrule || '')}" /></label>
    </div>
    <label>Cadence (human)<input id="${prefix}Cadence" value="${esc(t.cadence_text || '')}" placeholder="Every Thursday" /></label>
    <p class="meta">Derived RRULE: <code id="${prefix}RrulePreview">${esc(t.rrule || 'FREQ=WEEKLY;BYDAY=TH')}</code></p>
    <input type="hidden" id="${prefix}Rrule" value="${esc(t.rrule || 'FREQ=WEEKLY;BYDAY=TH')}" />
    <input type="hidden" id="${prefix}PhaseStart" value="${esc(b.phaseStart || '')}" />
    <label>Duration (min)<input id="${prefix}Dur" type="number" min="5" value="${t.duration_min || 60}" /></label>
    <label>Priority<select id="${prefix}Pri">${prioritySelectOptions(t.priority || 'p1')}</select></label>
    <label>Ideal time<input id="${prefix}Time" type="time" value="${String(t.ideal_time || '09:00').slice(0, 5)}" /></label>
    <label>Window days (how far slot may drift from ideal)<input id="${prefix}Win" type="number" min="0" value="${t.window_days != null ? t.window_days : 2}" /></label>
    <label class="rec-toggle"><input id="${prefix}Crit" type="checkbox" ${t.time_critical ? 'checked' : ''} /> Time-critical (deadline: roll <strong>earlier</strong>; month-day / 1MO anchors always roll <strong>forward</strong> only)</label>
    <div class="rec-reanchor inset">
      <h3 style="font-size:13px;margin:0 0 6px">Re-anchor series (optional)</h3>
      <p class="meta" style="margin:0 0 6px">Sets the next ideal date and recalculates later dates from your frequency. Leave blank to keep the current phase.</p>
      <label>Next due / re-anchor date<input id="${prefix}Reanchor" type="date" value="" /></label>
      <label class="rec-toggle"><input id="${prefix}ReanchorGo" type="checkbox" /> Rebuild series from this date on Save</label>
    </div>
    <div class="rec-planned" id="${prefix}PlannedWrap">
      <h3 style="font-size:13px;margin:8px 0 4px">Planned dates</h3>
      <p class="meta" style="margin:0 0 6px">Change the <strong>first</strong> date to rebuild later occurrences from that point (same as re-anchor). Change a <strong>later</strong> row to override that occurrence only.</p>
      <div id="${prefix}Planned" class="rec-planned-list"></div>
    </div>
    <label>Legacy note (optional)<input id="${prefix}Sched" value="${esc(t.scheduled_note || '')}" placeholder="Ignored by Occurrences column — diary log is truth" /></label>
    <label>Notes<textarea id="${prefix}Notes" rows="3">${esc(t.notes_md || '')}</textarea></label>
    <p class="meta">Overrides write to <strong>recurring_log</strong> (same as Diary drag). Push syncs Google.</p>`;
}

function readBuilderState(prefix) {
  const pattern = $(`${prefix}Pattern`)?.value || 'weekly';
  return {
    pattern,
    interval: Number($(`${prefix}Interval`)?.value) || 1,
    byday: $(`${prefix}Byday`)?.value || 'WE',
    nth: Number($(`${prefix}Nth`)?.value) || 1,
    monthday: Number($(`${prefix}Monthday`)?.value) || 1,
    customRrule: $(`${prefix}CustomRrule`)?.value || '',
    phaseStart: $(`${prefix}PhaseStart`)?.value || null,
  };
}

function syncBuilderVisibility(prefix) {
  const pattern = $(`${prefix}Pattern`)?.value || 'weekly';
  const show = (cls, on) => {
    document.querySelectorAll(`#modal .${cls}`).forEach((el) => {
      el.style.display = on ? '' : 'none';
    });
  };
  show('rec-bld-dow', pattern === 'weekly' || pattern === 'monthly_nth');
  show('rec-bld-nth', pattern === 'monthly_nth');
  show('rec-bld-dom', pattern === 'monthly_dom');
  show('rec-bld-custom', pattern === 'custom');
  const ivLabel = $(`${prefix}Interval`)?.closest('label');
  if (ivLabel && ivLabel.childNodes[0]) {
    ivLabel.childNodes[0].textContent = pattern === 'monthly_dom' || pattern === 'monthly_nth'
      ? 'Every N months '
      : 'Every N weeks ';
  }
}

function applyBuilderToHidden(prefix, { syncCadence = true } = {}) {
  const state = readBuilderState(prefix);
  const rrule = buildRrule(state);
  const hidden = $(`${prefix}Rrule`);
  const preview = $(`${prefix}RrulePreview`);
  if (hidden) hidden.value = rrule;
  if (preview) preview.textContent = rrule;
  if (syncCadence) {
    const auto = humanCadence(state);
    const cad = $(`${prefix}Cadence`);
    if (cad && auto) cad.value = auto;
  }
  return rrule;
}

function plannedRowHtml(prefix, task, ideal, rowState) {
  const st = occurrenceStatus(task || { id: '', last_done: null }, ideal);
  const day = rowState.day || ideal;
  const start = rowState.start || String(task?.ideal_time || '09:00').slice(0, 5);
  const end = rowState.end || addMinutesHm(start, task?.duration_min || 60);
  const dirty = rowState.dirty ? ' rec-planned-dirty' : '';
  const locked = st.kind === 'done' || st.kind === 'skipped';
  return `<div class="rec-planned-row${dirty}" data-ideal="${esc(ideal)}">
    <div class="rec-planned-ideal"><strong>${esc(fmtOccDay(ideal))}</strong>
      <span class="meta">${esc(st.kind)}</span></div>
    <label>Date<input type="date" data-pl-day="${esc(ideal)}" value="${esc(day)}" ${locked ? 'disabled' : ''} /></label>
    <label>Start<input type="time" data-pl-start="${esc(ideal)}" value="${esc(start)}" ${locked ? 'disabled' : ''} /></label>
    <label>End<input type="time" data-pl-end="${esc(ideal)}" value="${esc(end)}" ${locked ? 'disabled' : ''} /></label>
  </div>`;
}

function defaultPlannedState(task, ideal) {
  const st = occurrenceStatus(task || { id: '', last_done: null }, ideal);
  let day = ideal;
  let start = String(task?.ideal_time || '09:00').slice(0, 5);
  let end = addMinutesHm(start, task?.duration_min || 60);
  if (st.kind === 'pinned') {
    const log = latestLogForIdeal(task.id, ideal);
    if (log?.scheduled_date) day = log.scheduled_date;
    const m = String(log?.change || '').match(/^diary_pin:([^|]+)\|([^|]+)/);
    if (m) {
      const hm = londonHmFromIso(m[1]);
      const hmEnd = londonHmFromIso(m[2]);
      if (hm) start = hm;
      if (hmEnd) end = hmEnd;
    }
  }
  return { day, start, end, dirty: false };
}

function renderPlannedList(prefix, task, overrides) {
  const wrap = $(`${prefix}Planned`);
  if (!wrap) return;
  const rrule = $(`${prefix}Rrule`)?.value || task?.rrule || '';
  const fake = { ...(task || {}), id: task?.id || '', rrule, ideal_time: $(`${prefix}Time`)?.value || task?.ideal_time || '09:00', duration_min: Number($(`${prefix}Dur`)?.value) || task?.duration_min || 60 };
  const ideals = upcomingIdeals(fake, 8);
  wrap.innerHTML = ideals.length
    ? ideals.map((ideal) => {
      const base = overrides.get(ideal) || defaultPlannedState(fake, ideal);
      return plannedRowHtml(prefix, fake, ideal, base);
    }).join('')
    : '<p class="meta">No upcoming dates from this cadence.</p>';
}

function collectDirtyOverrides(prefix, habitId) {
  const rows = [];
  document.querySelectorAll(`#${prefix}Planned .rec-planned-row.rec-planned-dirty`).forEach((row) => {
    const ideal = row.getAttribute('data-ideal');
    const day = row.querySelector('[data-pl-day]')?.value;
    const start = row.querySelector('[data-pl-start]')?.value;
    const end = row.querySelector('[data-pl-end]')?.value;
    if (!ideal || !day || !start || !end) return;
    const log = habitId ? latestLogForIdeal(habitId, ideal) : null;
    rows.push({
      ideal,
      day,
      start,
      end,
      dirty: true,
      calendar_event_id: log?.calendar_event_id || null,
    });
  });
  return rows;
}

/** Snapshot first planned row (ideal / day / times / event id). */
function readFirstPlannedRow(prefix, habitId) {
  const row = document.querySelector(`#${prefix}Planned .rec-planned-row`);
  if (!row) return null;
  const ideal = row.getAttribute('data-ideal');
  const day = row.querySelector('[data-pl-day]')?.value || '';
  const start = row.querySelector('[data-pl-start]')?.value || '';
  const end = row.querySelector('[data-pl-end]')?.value || '';
  const log = habitId && ideal ? latestLogForIdeal(habitId, ideal) : null;
  return {
    ideal,
    day,
    start,
    end,
    calendar_event_id: log?.calendar_event_id || null,
  };
}

/** First planned date → series re-anchor so later ideals recalculate from that day. */
function reanchorFromPlannedDate(prefix, ymd, overrides, refresh, keepTimes = null, task = null) {
  const day = String(ymd || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
  const reDate = $(`${prefix}Reanchor`);
  const reGo = $(`${prefix}ReanchorGo`);
  if (reDate) reDate.value = day;
  if (reGo) reGo.checked = true;
  $(`${prefix}PhaseStart`).value = day;
  const pattern = $(`${prefix}Pattern`)?.value || 'weekly';
  if (pattern === 'weekly' || pattern === 'monthly_nth') {
    $(`${prefix}Byday`).value = dowCodeFromYmd(day);
  }
  if (pattern === 'monthly_nth' || pattern === 'monthly_dom') {
    $(`${prefix}Pattern`).value = 'monthly_dom';
    $(`${prefix}Monthday`).value = String(Number(day.slice(8, 10)));
  }
  overrides.clear();
  if (keepTimes?.start && keepTimes?.end) {
    overrides.set(day, {
      day,
      start: keepTimes.start,
      end: keepTimes.end,
      dirty: true,
    });
  }
  syncBuilderVisibility(prefix);
  applyBuilderToHidden(prefix, { syncCadence: true });
  renderPlannedList(prefix, task, overrides);
}

function wireCadenceBuilder(prefix, task) {
  const overrides = new Map();
  const cadenceTouched = { v: false };
  const cad = $(`${prefix}Cadence`);
  if (cad) cad.addEventListener('input', () => { cadenceTouched.v = true; });

  const refresh = () => {
    applyBuilderToHidden(prefix, { syncCadence: !cadenceTouched.v });
    renderPlannedList(prefix, task, overrides);
  };

  syncBuilderVisibility(prefix);
  applyBuilderToHidden(prefix, { syncCadence: !tHasCadence(task) });
  renderPlannedList(prefix, task, overrides);

  // If first row is already pinned off its ideal (e.g. Oct ideal on Aug date),
  // rebuild the preview immediately so later dates shift.
  const first = readFirstPlannedRow(prefix, task?.id);
  if (first?.day && first?.ideal && first.day !== first.ideal) {
    reanchorFromPlannedDate(prefix, first.day, overrides, refresh, {
      start: first.start,
      end: first.end,
    }, task);
  }

  ['Pattern', 'Interval', 'Byday', 'Nth', 'Monthday', 'CustomRrule', 'Time', 'Dur'].forEach((suf) => {
    const el = $(`${prefix}${suf}`);
    if (!el) return;
    el.addEventListener('change', () => {
      syncBuilderVisibility(prefix);
      overrides.clear();
      refresh();
    });
    el.addEventListener('input', () => {
      if (suf === 'CustomRrule' || suf === 'Interval' || suf === 'Monthday') {
        syncBuilderVisibility(prefix);
        overrides.clear();
        refresh();
      }
    });
  });

  const planned = $(`${prefix}Planned`);
  if (planned) {
    planned.addEventListener('change', (e) => {
      const t = e.target;
      const ideal = t.getAttribute('data-pl-day') || t.getAttribute('data-pl-start') || t.getAttribute('data-pl-end');
      if (!ideal) return;
      const row = t.closest('.rec-planned-row');
      if (!row) return;
      const firstRow = planned.querySelector('.rec-planned-row');
      const isFirst = firstRow === row;
      const isDateField = t.hasAttribute('data-pl-day');
      const day = row.querySelector('[data-pl-day]')?.value || '';
      const start = row.querySelector('[data-pl-start]')?.value || '09:00';
      const end = row.querySelector('[data-pl-end]')?.value || '10:00';
      if (isFirst && isDateField && day) {
        reanchorFromPlannedDate(prefix, day, overrides, refresh, { start, end }, task);
        return;
      }
      row.classList.add('rec-planned-dirty');
      overrides.set(ideal, { day, start, end, dirty: true });
    });
  }

  const reGo = $(`${prefix}ReanchorGo`);
  const reDate = $(`${prefix}Reanchor`);
  if (reGo && reDate) {
    reGo.addEventListener('change', () => {
      if (!reGo.checked || !reDate.value) return;
      const snap = readFirstPlannedRow(prefix, task?.id);
      reanchorFromPlannedDate(prefix, reDate.value, overrides, refresh, {
        start: snap?.start,
        end: snap?.end,
      }, task);
    });
    reDate.addEventListener('change', () => {
      if (reGo.checked && reDate.value) {
        const snap = readFirstPlannedRow(prefix, task?.id);
        reanchorFromPlannedDate(prefix, reDate.value, overrides, refresh, {
          start: snap?.start,
          end: snap?.end,
        }, task);
      }
    });
  }

  return {
    overrides,
    collectDirtyOverrides: () => collectDirtyOverrides(prefix, task?.id),
    readFirstPlannedRow: () => readFirstPlannedRow(prefix, task?.id),
    forceReanchorIfDrifted: () => {
      const snap = readFirstPlannedRow(prefix, task?.id);
      if (snap?.day && snap?.ideal && snap.day !== snap.ideal) {
        reanchorFromPlannedDate(prefix, snap.day, overrides, refresh, {
          start: snap.start,
          end: snap.end,
        }, task);
        return snap;
      }
      return null;
    },
  };
}

function tHasCadence(task) {
  return !!(task && String(task.cadence_text || '').trim());
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
  if (/^completed\s/i.test(ch)) {
    const m = ch.match(/^completed\s+(\d{4}-\d{2}-\d{2})(?:\|actual=(\d+))?/i);
    const actual = m?.[2] ? ` · ${m[2]}m` : '';
    return { kind: 'done', text: `${m?.[1] || idealYmd} · done${actual}` };
  }
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
  const to = addDaysYmd(today, 180);
  try {
    let phaseAnchor = today;
    try {
      const last = lastDueOnOrBefore(task.rrule, addDaysYmd(today, -1));
      if (last) phaseAnchor = last;
    } catch (_) { /* ignore */ }
    const all = idealsInHorizon(task.rrule, today, to, 200, phaseAnchor);
    return (all.length ? all : []).slice(0, count);
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
  applyBuilderToHidden(prefix, { syncCadence: false });
  let rrule = $(`${prefix}Rrule`).value.trim();
  const reGo = $(`${prefix}ReanchorGo`);
  const reDate = $(`${prefix}Reanchor`);
  let reanchor_ymd = null;
  if (reGo?.checked && reDate?.value) {
    reanchor_ymd = reDate.value;
    const pattern = $(`${prefix}Pattern`)?.value;
    if (pattern === 'weekly' || pattern === 'monthly_nth') {
      $(`${prefix}Byday`).value = dowCodeFromYmd(reanchor_ymd);
    }
    $(`${prefix}PhaseStart`).value = reanchor_ymd;
    rrule = setPhaseStart(buildRrule(readBuilderState(prefix)), reanchor_ymd);
    $(`${prefix}Rrule`).value = rrule;
  }
  return {
    title: $(`${prefix}Title`).value.trim(),
    cadence_text: $(`${prefix}Cadence`).value.trim(),
    rrule,
    duration_min: Number($(`${prefix}Dur`).value) || 60,
    priority: $(`${prefix}Pri`).value || 'p1',
    ideal_time: $(`${prefix}Time`).value || '09:00',
    window_days: Number($(`${prefix}Win`).value),
    time_critical: $(`${prefix}Crit`).checked,
    scheduled_note: $(`${prefix}Sched`).value.trim() || null,
    notes_md: $(`${prefix}Notes`).value.trim() || null,
    reanchor_ymd,
    cull_obsolete_pins: !!reanchor_ymd,
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
        <button type="button" class="btn-secondary" data-rec-skip="${t.id}" title="Skip the next open occurrence in the list (removes it from Google if placed)">Skip Next</button>
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
  modal.classList.add('wide');
  wireCadenceBuilder('re', { ideal_time: '09:00', duration_min: 60, rrule: 'FREQ=WEEKLY;BYDAY=TH' });
  $('reCancel').onclick = () => { modal.classList.remove('open'); modal.classList.remove('wide'); };
  $('reSave').onclick = async () => {
    const body = readForm('re');
    if (!body.title || !body.rrule || !body.cadence_text) {
      alert('Title, cadence, and pattern/RRULE are required.');
      return;
    }
    const { reanchor_ymd, cull_obsolete_pins, ...taskBody } = body;
    void reanchor_ymd; void cull_obsolete_pins;
    await api('/api/mc/recurring', { method: 'POST', body: taskBody });
    modal.classList.remove('open');
    modal.classList.remove('wide');
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
  modal.classList.add('wide');
  const builder = wireCadenceBuilder('re', t);
  $('reCancel').onclick = () => { modal.classList.remove('open'); modal.classList.remove('wide'); };
  $('reSave').onclick = async () => {
    // Capture event id from current first pin BEFORE re-anchor rebuilds the list.
    const preSnap = builder.readFirstPlannedRow();
    builder.forceReanchorIfDrifted();
    const body = readForm('re');
    const dayEl = $('reOccDay');
    const startEl = $('reOccStart');
    const endEl = $('reOccEnd');
    const willMove = !!(occurrence && dayEl && startEl && endEl
      && dayEl.value && startEl.value && endEl.value);
    let dirty = builder.collectDirtyOverrides();
    // After re-anchor, first ideal is the new day — pin times + transfer old GCal id.
    const postSnap = builder.readFirstPlannedRow();
    const preserveEvt = preSnap?.calendar_event_id || null;
    if (body.reanchor_ymd && postSnap?.day && (preSnap?.start || postSnap.start)) {
      const already = dirty.find((r) => r.ideal === postSnap.day || r.day === postSnap.day);
      if (!already) {
        dirty = [{
          ideal: postSnap.day,
          day: postSnap.day,
          start: postSnap.start || preSnap?.start || body.ideal_time,
          end: postSnap.end || preSnap?.end || addMinutesHm(body.ideal_time, body.duration_min),
          dirty: true,
          calendar_event_id: preserveEvt,
        }, ...dirty];
      } else if (preserveEvt && !already.calendar_event_id) {
        already.calendar_event_id = preserveEvt;
      }
    }
    // Keep habit ideal_time in sync when first occurrence time was edited.
    if (postSnap?.start && postSnap.start !== body.ideal_time) {
      body.ideal_time = postSnap.start;
    }
    const saveBtn = $('reSave');
    const cancelBtn = $('reCancel');
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = (willMove || dirty.length || body.reanchor_ymd) ? 'Saving + syncing…' : 'Saving…';
    }
    if (cancelBtn) cancelBtn.disabled = true;

    const { reanchor_ymd, cull_obsolete_pins, ...taskBody } = body;
    const patchBody = {
      id: t.id,
      ...taskBody,
      ideal_time: body.ideal_time,
      reanchor_ymd: reanchor_ymd || undefined,
      cull_obsolete_pins: cull_obsolete_pins || undefined,
      preserve_calendar_event_id: preserveEvt || undefined,
    };

    if (!willMove && !dirty.length) {
      try {
        await api('/api/mc/recurring', { method: 'PATCH', body: patchBody });
        modal.classList.remove('open');
        modal.classList.remove('wide');
        if (onSave) await onSave();
      } catch (err) {
        window.alert(err.message || 'Save failed');
        if (saveBtn) {
          saveBtn.disabled = false;
          saveBtn.textContent = occurrence ? 'Save habit + move occurrence' : 'Save';
        }
        if (cancelBtn) cancelBtn.disabled = false;
      }
      return;
    }

    const ui = openMcBusyModal({
      title: 'Saving recurring habit',
      doneTitle: 'Saved',
      failTitle: 'Save failed',
      phases: [
        'Update habit settings',
        willMove ? 'Pin diary occurrence' : 'Apply date overrides',
        'Auto-sync with Google (can take 20–40s)',
        'Refresh',
      ],
    });
    try {
      ui.setPhase(0, 'saving habit…');
      await api('/api/mc/recurring', { method: 'PATCH', body: patchBody });
      let writes = 0;
      if (willMove) {
        ui.setPhase(1, `moving to ${dayEl.value} ${startEl.value}…`);
        const res = await api('/api/mc/diary-action', {
          method: 'POST',
          body: {
            action: 'move',
            habit_id: t.id,
            title: body.title || t.title,
            ideal_date: idealDay,
            new_start: londonYmdHmToIso(dayEl.value, startEl.value),
            new_end: londonYmdHmToIso(dayEl.value, endEl.value),
            override: true,
            calendar_event_id: occurrence?.calendar_event_id || preserveEvt || undefined,
          },
        });
        writes += res?.calendar_writes ?? 0;
      }
      if (dirty.length) {
        ui.setPhase(1, `overriding ${dirty.length} date(s)…`);
        for (const row of dirty) {
          const res = await api('/api/mc/diary-action', {
            method: 'POST',
            body: {
              action: 'move',
              habit_id: t.id,
              title: body.title || t.title,
              ideal_date: row.ideal,
              new_start: londonYmdHmToIso(row.day, row.start),
              new_end: londonYmdHmToIso(row.day, row.end),
              override: true,
              calendar_event_id: row.calendar_event_id || preserveEvt || undefined,
            },
          });
          writes += res?.calendar_writes ?? 0;
        }
      }
      ui.setPhase(2, 'Google sync…');
      ui.setPhase(3, 'refreshing…');
      if (onSave) await onSave();
      ui.finish(
        writes > 0
          ? `Saved and synced to Google (${writes} write${writes === 1 ? '' : 's'}).`
          : 'Saved. Google sync skipped or had nothing to write.',
      );
      modal.classList.remove('wide');
    } catch (err) {
      ui.fail(err);
      modal.classList.remove('wide');
    }
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

let skipBusy = false;

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
    if (skipBusy) return true;
    const btn = done;
    const label = btn.textContent;
    skipBusy = true;
    btn.disabled = true;
    btn.textContent = 'Saving…';
    const ui = openMcBusyModal({
      title: 'Marking habit done',
      doneTitle: 'Done saved',
      failTitle: 'Mark done failed',
      phases: [
        'Save this occurrence as done',
        'Move the Google Calendar block to now',
        'Auto-sync with Google (can take 20–40s)',
        'Refresh Occurrences list',
      ],
    });
    try {
      ui.setPhase(0, 'saving…');
      ui.setPhase(1, 'queue Google move…');
      const res = await api('/api/mc/recurring', {
        method: 'POST',
        body: { action: 'mark_done', id: btn.getAttribute('data-rec-done') },
      });
      ui.setPhase(2, 'Google sync…');
      const writes = res?.task?.calendar_writes ?? res?.calendar_writes ?? 0;
      ui.setPhase(3, 'refreshing…');
      if (onSave) await onSave();
      ui.finish(
        writes > 0
          ? `Marked done today. Google updated (${writes} write${writes === 1 ? '' : 's'}).`
          : 'Marked done today. Google sync skipped or had nothing to write.',
      );
    } catch (err) {
      ui.fail(err);
      window.alert(err.message || 'Mark done failed');
    } finally {
      skipBusy = false;
      btn.disabled = false;
      btn.textContent = label;
    }
    return true;
  }
  const skip = e.target.closest('[data-rec-skip]');
  if (skip) {
    if (skipBusy) return true;
    const reason = window.prompt(
      'Skip Next occurrence (first open date in the list) — optional reason (blank is fine):',
      '',
    ) ?? null;
    if (reason === null) return true; // cancelled prompt
    const btn = skip;
    const label = btn.textContent;
    skipBusy = true;
    btn.disabled = true;
    btn.textContent = 'Skipping…';
    const ui = openMcBusyModal({
      title: 'Skip Next in progress',
      doneTitle: 'Skip Next complete',
      failTitle: 'Skip Next failed',
      phases: [
        'Mark occurrence skipped in diary',
        'Queue Google Calendar delete',
        'Auto-sync with Google (can take 20–40s)',
        'Refresh Occurrences list',
      ],
    });
    try {
      ui.setPhase(1, 'writing skip…');
      const res = await api('/api/mc/recurring', {
        method: 'POST',
        body: { action: 'skip', id: btn.getAttribute('data-rec-skip'), reason: reason || null },
      });
      ui.setPhase(2, 'Google sync…');
      const day = res?.task?.skipped_occurrence || res?.skipped_occurrence;
      const writes = res?.task?.calendar_writes ?? res?.calendar_writes ?? 0;
      ui.setPhase(3, 'refreshing…');
      if (onSave) await onSave();
      const msg = day
        ? (writes > 0
          ? `Skipped ${day} and removed it from Google (${writes} write${writes === 1 ? '' : 's'}).`
          : `Skipped ${day}. No Google event to remove (or auto-sync did not run).`)
        : 'Skip Next finished.';
      ui.finish(msg);
    } catch (err) {
      ui.fail(err);
    } finally {
      skipBusy = false;
      btn.disabled = false;
      btn.textContent = label;
    }
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

/** Shared progress modal for Recurring / Diary actions that wait on Google sync. */
export function openMcBusyModal({
  title,
  phases,
  doneTitle = 'Complete',
  failTitle = 'Failed',
} = {}) {
  const modal = $('modal');
  const box = $('modalBox');
  const started = Date.now();
  let tick = 0;
  let phaseIdx = 0;
  let note = '';
  let timer = null;

  const paint = () => {
    const elapsed = Math.round((Date.now() - started) / 1000);
    const pct = Math.min(92, 18 + tick * 9);
    const list = (phases || []).map((p, i) => {
      const cls = i < phaseIdx ? 'done' : (i === phaseIdx ? 'active' : '');
      const mark = i < phaseIdx ? '✓' : (i === phaseIdx ? '…' : '·');
      return `<li class="${cls}"><span class="sched-phase-mark">${mark}</span>${esc(p)}</li>`;
    }).join('');
    box.innerHTML = `
      <h2 style="font-size:16px;font-weight:600;margin-bottom:4px">${esc(title || 'Working…')}</h2>
      <p class="meta">Elapsed ${elapsed}s${note ? ` · ${esc(note)}` : ''}
        · Google sync often takes 20–40s — leave this open</p>
      <div class="sched-prog-bar"><div class="sched-prog-fill" style="width:${pct}%"></div></div>
      <ul class="sched-phase-list" style="margin-top:10px">${list}</ul>`;
  };

  paint();
  modal.classList.add('open');
  timer = setInterval(() => {
    tick += 1;
    paint();
  }, 1500);

  return {
    setPhase(i, n) {
      phaseIdx = Math.max(0, Math.min((phases || []).length - 1, i));
      note = n || '';
      paint();
    },
    finish(msg) {
      clearInterval(timer);
      const secs = Math.round((Date.now() - started) / 1000);
      box.innerHTML = `
        <h2 style="font-size:16px;font-weight:600;margin-bottom:4px">${esc(doneTitle)}</h2>
        <p class="meta">Finished in ${secs}s</p>
        <p style="margin-top:10px">${esc(msg || 'Done.')}</p>
        <div class="sched-prog-bar"><div class="sched-prog-fill" style="width:100%"></div></div>
        <div style="display:flex;gap:8px;margin-top:14px">
          <button type="button" class="btn-verify" id="recBusyClose">Close</button>
        </div>`;
      const close = () => modal.classList.remove('open');
      $('recBusyClose').onclick = close;
      setTimeout(close, 2200);
    },
    fail(err) {
      clearInterval(timer);
      box.innerHTML = `
        <h2 style="font-size:16px;font-weight:600;margin-bottom:8px">${esc(failTitle)}</h2>
        <p class="err">${esc(err?.message || String(err) || 'Unknown error')}</p>
        <button type="button" class="btn-verify" id="recBusyClose">Close</button>`;
      $('recBusyClose').onclick = () => modal.classList.remove('open');
    },
  };
}
