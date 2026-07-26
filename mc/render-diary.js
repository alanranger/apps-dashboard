/**
 * Diary tab — Outlook-style 4-week reschedule grid (UI).
 * DB writes via /api/mc/diary-action; GCal flush via /api/mc/gcal-push (Claude).
 */
import { api } from './api.js';
import { $ } from './util.js';
import { openDrawer } from './drawer.js';
import { openRecurringEdit } from './render-recurring.js';
import { applyBootstrap } from './store.js';

const KIND_CLASS = {
  workshop: 'dy-workshop',
  lesson: 'dy-lesson',
  mc_task: 'dy-task',
  habit: 'dy-habit',
  travel: 'dy-travel',
  buffer: 'dy-buffer',
  fixture: 'dy-fixture',
  personal: 'dy-personal',
};

const KIND_ICON = {
  workshop: '📷',
  lesson: '🎓',
  habit: '🔁',
  mc_task: '📋',
  travel: '🚗',
  buffer: '⏳',
  fixture: '⚽',
  personal: '•',
};

const WEEKDAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
const MIN_BLOCK_PX = 24;
let diaryState = { data: null, menu: null };

function minsToTop(min, axis) {
  const span = axis.end_min - axis.start_min;
  return ((min - axis.start_min) / span) * 100;
}

function heightPct(dur, axis) {
  const span = axis.end_min - axis.start_min;
  const gridPx = axis.grid_px || 640;
  return Math.max((dur / span) * 100, (MIN_BLOCK_PX / gridPx) * 100);
}

function fmtHm(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function fmtDayLabel(ymd) {
  const d = new Date(`${ymd}T12:00:00Z`);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function weekdayIndex(ymd) {
  const dow = new Date(`${ymd}T12:00:00Z`).getUTCDay();
  return dow === 0 ? 6 : dow - 1; // Mon=0 … Sun=6
}

/** London wall-clock ymd+HH:MM → ISO (same correction loop as placer). */
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

function toast(msg) {
  let el = document.getElementById('dy-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'dy-toast';
    el.className = 'dy-toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 3200);
}

function closeMenu() {
  diaryState.menu = null;
  const el = document.getElementById('dy-menu');
  if (el) el.remove();
}

function showMenu(block, x, y, refresh) {
  closeMenu();
  if (block.is_buffer || block.synthetic) return;
  const menu = document.createElement('div');
  menu.id = 'dy-menu';
  menu.className = 'dy-menu';
  menu.style.left = `${Math.min(x, window.innerWidth - 200)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - 180)}px`;

  if (block.read_only || !block.editable) {
    const why = block.client_fixed
      ? 'Locked client booking (from Google Calendar) — not movable here.'
      : 'Read-only calendar block — drag green habits / blue tasks only.';
    menu.innerHTML = `<div class="dy-menu-note">${why}</div>`;
    document.body.appendChild(menu);
    diaryState.menu = { block };
    return;
  }

  const items = [
    ['complete', 'Mark complete'],
    ['settime', 'Amend / open details…'],
  ];
  if (block.kind === 'mc_task') {
    items.push(block.slot_pinned ? ['unlock', 'Unlock slot'] : ['lock', 'Lock slot']);
    items.push(['dismiss', 'Dismiss']);
  } else if (block.kind === 'habit') {
    items.push(['skip', 'Skip occurrence']);
  }
  menu.innerHTML = items.map(([a, label]) => (
    `<button type="button" data-dy-act="${a}">${label}</button>`
  )).join('');
  document.body.appendChild(menu);
  diaryState.menu = { block };
  menu.onclick = async (e) => {
    const btn = e.target.closest('[data-dy-act]');
    if (!btn) return;
    const act = btn.getAttribute('data-dy-act');
    closeMenu();
    await runMenuAction(act, block, refresh);
  };
}

function askActualMinutes(block) {
  const planned = block.duration_min || block.est_minutes || 30;
  const raw = window.prompt(
    `Actual minutes spent on:\n${block.title}\n\n(planned ${planned}m — Enter what really happened)`,
    String(planned),
  );
  if (raw == null) return null; // cancel
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n) || n <= 0) {
    alert('Enter a positive number of minutes');
    return null;
  }
  return n;
}

async function runMenuAction(act, block, refresh) {
  try {
    if (act === 'complete') {
      const actual = askActualMinutes(block);
      if (actual == null) return;
      await api('/api/mc/diary-action', {
        method: 'POST',
        body: {
          action: 'complete',
          task_id: block.kind === 'mc_task' ? block.id.replace(/^task:/, '') : undefined,
          habit_id: block.habit_id || undefined,
          display_id: block.display_id || undefined,
          completed_on: block.day || undefined,
          scheduled_date: block.day || undefined,
          ideal_date: block.ideal_date || block.day || undefined,
          calendar_event_id: block.calendar_event_id || undefined,
          actual_minutes: actual,
        },
      });
      toast(`Completed · ${actual}m actual · queued for Claude`);
    } else if (act === 'lock' || act === 'unlock') {
      await api('/api/mc/diary-action', {
        method: 'POST',
        body: { action: act, task_id: block.id.replace(/^task:/, '') },
      });
    } else if (act === 'dismiss') {
      if (!confirm('Dismiss this task (wont_do)?')) return;
      await api('/api/mc/diary-action', {
        method: 'POST',
        body: { action: 'dismiss', task_id: block.id.replace(/^task:/, '') },
      });
    } else if (act === 'skip') {
      if (!confirm(`Skip this occurrence only?\n${block.title}\n\nRemoves it from this day. Next scheduled occurrence still appears.`)) return;
      await api('/api/mc/diary-action', {
        method: 'POST',
        body: {
          action: 'skip',
          habit_id: block.habit_id,
          scheduled_date: block.day,
          ideal_date: block.ideal_date || block.day,
          calendar_event_id: block.calendar_event_id || undefined,
        },
      });
      toast('Skipped this occurrence · next cycle still schedules');
    } else if (act === 'settime') {
      const afterSave = async () => {
        try {
          const data = await api('/api/mc/bootstrap');
          applyBootstrap(data);
        } catch (e) { /* ignore */ }
        await refresh();
      };
      if (block.kind === 'mc_task') {
        const taskId = block.id.replace(/^task:/, '');
        try {
          const data = await api('/api/mc/bootstrap');
          applyBootstrap(data);
        } catch (e) { /* ignore */ }
        await openDrawer(taskId, afterSave);
        return;
      }
      if (block.kind === 'habit' && block.habit_id) {
        openRecurringEdit(block.habit_id, afterSave, {
          day: block.day,
          start_hm: fmtHm(block.start_min),
          end_hm: fmtHm(block.end_min),
          ideal_date: block.ideal_date || block.day,
          calendar_event_id: block.calendar_event_id || null,
        });
        return;
      }
      alert('No task/habit details to open for this block.');
      return;
    }
    await refresh();
  } catch (err) {
    alert(err.message || 'Action failed');
  }
}

async function dropBlock(block, day, startHm, endHm, override, refresh) {
  const body = {
    action: 'move',
    new_start: londonYmdHmToIso(day, startHm),
    new_end: londonYmdHmToIso(day, endHm),
    title: block.title,
    override: !!override,
    calendar_event_id: block.calendar_event_id || undefined,
  };
  if (block.kind === 'mc_task') {
    body.task_id = block.id.replace(/^task:/, '');
    if (block.slot_pinned) {
      alert('Pinned — unlock before dragging');
      return;
    }
  } else if (block.kind === 'habit') {
    body.habit_id = block.habit_id;
    body.ideal_date = block.ideal_date || block.day;
  } else {
    return;
  }
  const res = await api('/api/mc/diary-action', { method: 'POST', body });
  if (res.needs_override) {
    const msg = `Warnings:\n- ${res.warnings.join('\n- ')}\n\nOverride and place anyway?`;
    if (!confirm(msg)) return;
    body.override = true;
    await api('/api/mc/diary-action', { method: 'POST', body });
  }
  toast('Saved to DB · GCal change queued for Claude flush');
  await refresh();
}

function renderLegend() {
  const editable = [
    ['dy-task', '📋', 'Manual task', 'drag · ☑ · amend'],
    ['dy-habit', '🔁', 'Recurring habit', 'drag · ☑ · amend'],
  ];
  const readonly = [
    ['dy-workshop', '📷', 'Client booking', 'Zoom / workshop — locked'],
    ['dy-lesson', '🎓', 'Lesson', 'group class feed'],
    ['dy-fixture', '⚽', 'Fixture', 'match + pre/post'],
    ['dy-travel', '🚗', 'Travel', ''],
    ['dy-buffer', '⏳', 'Prep / decompress', ''],
    ['dy-personal', '•', 'Personal', 'Primary calendar'],
  ];
  const row = ([cls, icon, label, hint]) => `
    <div class="dy-leg-item">
      <span class="dy-leg-swatch ${cls}">${icon}</span>
      <span><strong>${label}</strong>${hint ? ` <span class="meta">${hint}</span>` : ''}</span>
    </div>`;
  return `
    <div class="dy-legend card">
      <div class="dy-leg-group">
        <div class="dy-leg-head dy-leg-head-edit">Editable — drag these</div>
        <div class="dy-leg-row">${editable.map(row).join('')}</div>
      </div>
      <div class="dy-leg-group">
        <div class="dy-leg-head dy-leg-head-ro">From calendar — read-only</div>
        <div class="dy-leg-row">${readonly.map(row).join('')}</div>
      </div>
      <p class="meta dy-leg-note">Blue tasks &amp; green habits only. Locked 🔒 client bookings cannot move.</p>
    </div>`;
}

function renderToolbar(data) {
  const push = data.push || {};
  const n = (push.open_count || 0) + (push.backlog_count || 0);
  const enabled = !!push.writes_available;
  return `
    <div class="dy-toolbar card">
      <div>
        <strong>Diary</strong>
        <span class="meta"> · Mon–Sun · 8 weeks · 30-min axis · ${data.from} → ${data.to}</span>
      </div>
      <p class="meta dy-edit-hint">Editable: <strong>blue tasks</strong> &amp; <strong>green habits</strong> (grab cursor + ☑). Everything else is Google Calendar truth.</p>
      <div class="dy-toolbar-actions">
        <button type="button" class="btn-secondary" data-dy-refresh>Refresh</button>
        <button type="button" class="btn-secondary" data-dy-push ${enabled ? '' : 'disabled'}
          title="${enabled ? 'Mark consolidated manifest ready for Claude' : 'GCal writes down — button disabled'}">
          Push ${n} to Google
        </button>
        <span class="meta">${enabled ? 'writes available' : 'writes blocked (Anthropic)'}</span>
      </div>
      <p class="meta dy-push-hint">
        Open push queue: <strong>${push.open_count || 0}</strong>
        · Away-span backlog: <strong>${push.backlog_count || 0}</strong>
      </p>
    </div>`;
}

function priorityTag(p) {
  if (!p) return '';
  const key = String(p).toLowerCase();
  if (key === 'p0') return '<span class="dy-pri dy-pri-p0">P0</span>';
  if (key === 'p1') return '<span class="dy-pri dy-pri-p1">P1</span>';
  return '';
}

function stackClass(kind, isBuffer) {
  if (isBuffer) return 'dy-z-buffer';
  if (kind === 'personal' || kind === 'fixture') return 'dy-z-personal';
  if (kind === 'travel') return 'dy-z-travel';
  if (kind === 'workshop' || kind === 'lesson') return 'dy-z-client';
  return 'dy-z-mc';
}

function renderBlock(b, axis) {
  const top = minsToTop(b.start_min, axis);
  const h = heightPct(b.duration_min || 30, axis);
  const cls = KIND_CLASS[b.kind] || 'dy-personal';
  const icon = KIND_ICON[b.kind] || '•';
  const locked = !!(b.slot_pinned || b.client_fixed);
  const isBuffer = !!(b.is_buffer || b.synthetic);
  const done = !!b.done;
  const tall = (b.duration_min || 30) >= 90 ? 'dy-tall' : '';
  const status = [
    b.overdue ? 'dy-overdue' : '',
    b.running_late ? 'dy-late' : '',
    locked ? 'dy-pinned' : '',
    b.editable && !locked ? 'dy-unlocked' : '',
    b.editable ? 'dy-edit' : 'dy-ro',
    isBuffer ? 'dy-buffer-strip' : '',
    b.client_fixed ? 'dy-client-fixed' : '',
    done ? 'dy-done-block' : '',
    stackClass(b.kind, isBuffer),
    tall,
  ].filter(Boolean).join(' ');
  const canEdit = !!(b.editable && !isBuffer && !done);
  const canDrag = !!(canEdit && !locked);
  const tipBits = [
    `${b.title} (${fmtHm(b.start_min)}–${fmtHm(b.end_min)})`,
    done && b.actual_minutes != null ? `Done · ${b.actual_minutes}m actual` : '',
    done && b.actual_minutes == null ? 'Done' : '',
    b.client_fixed ? 'Locked client booking — not movable' : '',
    canDrag ? 'Drag to reschedule · click for actions' : '',
    canEdit && locked ? 'Locked — unlock before dragging · click for actions' : '',
    !canEdit && !done ? 'Read-only (from Google Calendar)' : '',
  ].filter(Boolean);
  const lock = locked
    ? '<span class="dy-lock" aria-label="pinned">🔒</span>'
    : (canEdit ? '<span class="dy-lock-hint" aria-hidden="true">🔒</span>' : '');
  const drag = canDrag ? 'draggable="true"' : '';
  const doneBtn = canEdit && (b.kind === 'mc_task' || b.kind === 'habit')
    ? `<button type="button" class="dy-done" data-dy-done title="Mark complete">☑</button>`
    : '';
  const editBadge = canDrag
    ? '<span class="dy-edit-badge" title="Editable">EDIT</span>'
    : '';
  const doneBadge = done
    ? `<span class="dy-done-badge">DONE${b.actual_minutes != null ? ` ${b.actual_minutes}m` : ''}</span>`
    : '';
  const label = isBuffer
    ? (b.title && !/^decompress$/i.test(String(b.title).trim())
      ? `<span class="dy-type-icon" aria-hidden="true">${KIND_ICON.buffer}</span> ${b.title}`
      : `${KIND_ICON.buffer} decompress`)
    : `<span class="dy-type-icon" aria-hidden="true">${icon}</span> ${b.title}`;
  return `<div class="dy-block ${cls} ${status}"
    style="top:${top}%;height:${h}%"
    data-block-id="${b.id}"
    title="${tipBits.join(' · ')}"
    ${drag}>
    <div class="dy-block-row">
      ${doneBtn}
      <span class="dy-block-label">${label}</span>
      ${editBadge}
      ${doneBadge}
      ${priorityTag(b.priority)}
      ${lock}
    </div>
  </div>`;
}

function renderDayColumn(day, blocks, away, axis, banners, holidayTitle) {
  const dayBlocks = blocks.filter((b) => b.day === day);
  const awayCls = away ? ' dy-away' : '';
  const bhCls = holidayTitle ? ' dy-bh' : '';
  const awayBanner = away
    ? `<div class="dy-away-label" title="${away.summary || ''}">AWAY</div>`
    : '';
  const bhBadge = holidayTitle
    ? `<div class="dy-bh-badge" title="${holidayTitle}">BANK HOLIDAY</div>`
    : '';
  const dayBanners = (banners || [])
    .filter((b) => b.day === day)
    .map((b) => `<div class="dy-allday" title="${b.title}">${b.title}</div>`)
    .join('');
  const hours = [];
  const step = axis.step_min || 30;
  const gridPx = axis.grid_px || 1152;
  const pxStep = axis.px_per_step || 36;
  for (let m = axis.start_min; m < axis.end_min; m += step) {
    const half = m % 60 !== 0;
    hours.push(
      `<div class="dy-hour${half ? ' dy-hour-half' : ''}" style="top:${minsToTop(m, axis)}%">${fmtHm(m)}</div>`,
    );
  }
  const wd = WEEKDAYS[weekdayIndex(day)];
  return `
    <div class="dy-day${awayCls}${bhCls}" data-day="${day}">
      <div class="dy-day-head sticky">
        <div class="dy-wd">${wd}</div>
        <div class="dy-date">${fmtDayLabel(day)}</div>
        ${bhBadge}
      </div>
      ${dayBanners ? `<div class="dy-allday-stack">${dayBanners}</div>` : ''}
      <div class="dy-day-grid" data-day="${day}"
        style="height:${gridPx}px;--dy-step:${pxStep}px">
        ${awayBanner}
        ${hours.join('')}
        ${dayBlocks.map((b) => renderBlock(b, axis)).join('')}
      </div>
    </div>`;
}

function fmtHours(mins) {
  const h = Math.round((mins / 60) * 10) / 10;
  return `${h}h`;
}

function renderWeekBreakdown(cap) {
  const rows = [
    ['away', 'Away', 'dy-travel'],
    ['workshop', 'Client / workshop', 'dy-workshop'],
    ['lesson', 'Lesson', 'dy-lesson'],
    ['travel', 'Travel', 'dy-travel'],
    ['habit', 'Habits', 'dy-habit'],
    ['task', 'Tasks', 'dy-task'],
    ['fixture', 'Fixture', 'dy-fixture'],
    ['personal', 'Personal', 'dy-personal'],
    ['buffer', 'Buffers', 'dy-buffer'],
  ];
  const bh = cap.breakdown_h || {};
  const chips = rows
    .filter(([k]) => (bh[k] || 0) > 0)
    .map(([k, label, cls]) => `
      <span class="dy-bd-chip">
        <span class="dy-leg-swatch ${cls}"></span>
        <span>${label} <strong>${bh[k]}h</strong></span>
      </span>`)
    .join('');
  if (!chips) {
    return '<div class="dy-breakdown meta">No timed load this week</div>';
  }
  return `<div class="dy-breakdown" title="Hours by type (category sums; overlaps can mean types add up to more than clock hours)">${chips}</div>`;
}

function renderWeekGauge(week) {
  const cap = week.capacity || { pct: 0, filled_min: 0, available_min: 0, free_min: 0, over: false, label: '—' };
  const pct = Math.min(100, cap.pct || 0);
  const tone = cap.over || pct >= 95 ? 'dy-fuel-hot' : pct >= 75 ? 'dy-fuel-warm' : 'dy-fuel-ok';
  const start = week.days?.[0] || '';
  const end = week.days?.[6] || '';
  const awayN = cap.away_days || 0;
  const teachN = cap.teaching_days || 0;
  return `
    <div class="dy-fuel ${tone}" title="Committed hours vs realistic capacity: away≈05–22 full; teaching/client days have no admin free slots; normal days = core window + optional 19–21 unless evening class/fixture.">
      <div class="dy-fuel-meta">
        <strong>Week ${fmtDayLabel(start)} – ${fmtDayLabel(end)}</strong>
        <span>${cap.label || `${pct}%`}</span>
        <span class="meta">${fmtHours(cap.free_min || 0)} free (realistic)</span>
        ${awayN ? `<span class="meta">${awayN} away</span>` : ''}
        ${teachN ? `<span class="meta">${teachN} teaching</span>` : ''}
      </div>
      <div class="dy-fuel-track" aria-hidden="true">
        <div class="dy-fuel-fill" style="width:${pct}%"></div>
      </div>
      ${renderWeekBreakdown(cap)}
    </div>`;
}

function renderWeek(week, blocks, awayDays, axis, banners, holidays) {
  return `
    <div class="dy-week-wrap">
      ${renderWeekGauge(week)}
      <div class="dy-week">
        ${week.days.map((d) => renderDayColumn(
    d, blocks, awayDays[d], axis, banners, holidays?.[d],
  )).join('')}
      </div>
    </div>`;
}

function wireDiary(root, data, refresh) {
  const axis = data.day_axis || { start_min: 420, end_min: 1380, step_min: 30 };
  let dragBlock = null;
  let dragStarted = false;

  root.addEventListener('click', async (e) => {
    const blockEl = e.target.closest('.dy-block');
    if (!blockEl || !root.contains(blockEl)) return;
    e.preventDefault();
    e.stopPropagation();
    if (dragStarted) {
      dragStarted = false;
      return;
    }
    const block = (data.blocks || []).find((b) => b.id === blockEl.dataset.blockId);
    if (!block || block.is_buffer || block.synthetic) return;

      if (e.target.closest('[data-dy-done]')) {
      if (!block.editable || block.done) return;
      try {
        await runMenuAction('complete', block, refresh);
      } catch (err) {
        alert(err.message || 'Complete failed');
      }
      return;
    }

    blockEl.classList.add('dy-expanded');
    showMenu(block, e.clientX, e.clientY, refresh);
  });

  root.addEventListener('dragstart', (e) => {
    const blockEl = e.target.closest('.dy-block.dy-edit');
    if (!blockEl) {
      e.preventDefault();
      return;
    }
    if (e.target.closest('[data-dy-done]')) {
      e.preventDefault();
      return;
    }
    dragBlock = (data.blocks || []).find((b) => b.id === blockEl.dataset.blockId);
    if (!dragBlock || dragBlock.slot_pinned || dragBlock.client_fixed) {
      e.preventDefault();
      dragBlock = null;
      return;
    }
    dragStarted = true;
    root.classList.add('dy-dragging');
    e.dataTransfer.setData('text/plain', blockEl.dataset.blockId);
    e.dataTransfer.effectAllowed = 'move';
  });

  root.addEventListener('dragend', () => {
    root.classList.remove('dy-dragging');
    setTimeout(() => { dragStarted = false; }, 0);
    dragBlock = null;
  });

  root.querySelectorAll('.dy-day-grid').forEach((grid) => {
    grid.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });
    grid.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const day = grid.getAttribute('data-day');
      if (!dragBlock || !day) {
        toast('Nothing to drop — drag a green habit or blue task');
        return;
      }
      const rect = grid.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const span = axis.end_min - axis.start_min;
      const step = axis.step_min || 30;
      let startMin = Math.round((axis.start_min + (y / rect.height) * span) / step) * step;
      startMin = Math.max(axis.start_min, Math.min(startMin, axis.end_min - step));
      const dur = dragBlock.duration_min || 60;
      const endMin = Math.min(startMin + dur, axis.end_min);
      try {
        await dropBlock(dragBlock, day, fmtHm(startMin), fmtHm(endMin), false, refresh);
      } catch (err) {
        alert(err.message || 'Drop failed');
      }
      dragBlock = null;
      root.classList.remove('dy-dragging');
    });
  });
}

export async function renderDiary() {
  const el = $('view-diary');
  if (!el) return;
  el.innerHTML = '<div class="card"><p class="meta">Loading diary…</p></div>';
  try {
    const data = await api('/api/mc/diary?weeks=8');
    diaryState.data = data;
    const axis = data.day_axis;
    el.innerHTML = `
      ${renderToolbar(data)}
      ${renderLegend()}
      <div class="dy-scroll">
        ${(data.weeks || []).map((w) => renderWeek(
          w, data.blocks || [], data.away_days || {}, axis,
          data.day_banners || [], data.holidays || {},
        )).join('')}
      </div>`;
    wireDiary(el, data, () => renderDiary());
  } catch (e) {
    el.innerHTML = `<div class="card"><p class="err">Diary failed: ${e.message || e}</p></div>`;
  }
}

export async function handleDiaryClick(e, refresh) {
  if (e.target.closest('[data-dy-refresh]')) {
    await refresh();
    return true;
  }
  if (e.target.closest('[data-dy-push]')) {
    const btn = e.target.closest('[data-dy-push]');
    if (btn.disabled) {
      alert('Google Calendar writes are still down (gcal_writes_available=false). Manifest stays pending.');
      return true;
    }
    try {
      const res = await api('/api/mc/gcal-push', {
        method: 'PATCH',
        body: { action: 'mark_ready' },
      });
      alert(`Marked ${res.marked_ready} ready for Claude flush. Backlog still pending: ${res.backlog_still_pending}`);
      await refresh();
    } catch (err) {
      alert(err.message || 'Push failed');
    }
    return true;
  }
  if (!e.target.closest('#dy-menu') && !e.target.closest('.dy-block')) closeMenu();
  return false;
}
