/**
 * Diary tab — Outlook-style 4-week reschedule grid (UI).
 * DB writes via /api/mc/diary-action; GCal flush via /api/mc/gcal-push (Claude).
 */
import { api } from './api.js';
import { $ } from './util.js';

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
  mc_task: '☑️',
  travel: '🚗',
  buffer: '⏳',
  fixture: '⚽',
  personal: '•',
};

const WEEKDAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
const MIN_BLOCK_PX = 28;
let diaryState = { data: null, menu: null };

function minsToTop(min, axis) {
  const span = axis.end_min - axis.start_min;
  return ((min - axis.start_min) / span) * 100;
}

function heightPct(dur, axis) {
  const span = axis.end_min - axis.start_min;
  return Math.max((dur / span) * 100, (MIN_BLOCK_PX / 640) * 100);
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

function londonYmdHmToIso(ymd, hm) {
  return `${ymd}T${hm}:00.000Z`;
}

function closeMenu() {
  diaryState.menu = null;
  const el = document.getElementById('dy-menu');
  if (el) el.remove();
}

function showMenu(block, x, y, refresh) {
  closeMenu();
  if (block.read_only || block.is_buffer || block.synthetic) return;
  const menu = document.createElement('div');
  menu.id = 'dy-menu';
  menu.className = 'dy-menu';
  menu.style.left = `${Math.min(x, window.innerWidth - 200)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - 180)}px`;
  const items = [
    ['complete', 'Mark complete'],
    ['settime', 'Set date/time…'],
    block.slot_pinned ? ['unlock', 'Unlock slot'] : ['lock', 'Lock slot'],
    block.kind === 'habit' ? ['skip', 'Skip occurrence'] : ['dismiss', 'Dismiss'],
  ];
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

async function runMenuAction(act, block, refresh) {
  try {
    if (act === 'complete') {
      await api('/api/mc/diary-action', {
        method: 'POST',
        body: {
          action: 'complete',
          task_id: block.kind === 'mc_task' ? block.id.replace(/^task:/, '') : undefined,
          habit_id: block.habit_id || undefined,
          display_id: block.display_id || undefined,
        },
      });
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
      alert('Skip: mark in Recurring / pending if needed — habit skip via diary push coming next.');
      return;
    } else if (act === 'settime') {
      const day = prompt('Date YYYY-MM-DD', block.day);
      const start = prompt('Start HH:MM', fmtHm(block.start_min));
      const end = prompt('End HH:MM', fmtHm(block.end_min));
      if (!day || !start || !end) return;
      await dropBlock(block, day, start, end, true, refresh);
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
  await refresh();
}

function renderLegend() {
  const items = [
    ['dy-workshop', '📷', 'Client booking', 'workshop / shoot'],
    ['dy-lesson', '🎓', 'Lesson', 'class / 1-2-1'],
    ['dy-habit', '🔁', 'Recurring habit', ''],
    ['dy-task', '☑️', 'Manual task', 'MC-nn'],
    ['dy-travel', '🚗', 'Travel', ''],
    ['dy-buffer', '⏳', 'Prep / decompress', 'buffer'],
    ['dy-fixture', '⚽', 'Fixture', 'info'],
    ['dy-personal', '•', 'Personal', ''],
  ];
  return `
    <div class="dy-legend card">
      ${items.map(([cls, icon, label, hint]) => `
        <div class="dy-leg-item">
          <span class="dy-leg-swatch ${cls}">${icon}</span>
          <span><strong>${label}</strong>${hint ? ` <span class="meta">(${hint})</span>` : ''}</span>
        </div>`).join('')}
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
        <span class="meta"> · Mon–Sun · ${data.from} → ${data.to} · DB master · GCal read-only</span>
      </div>
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

function renderBlock(b, axis) {
  const top = minsToTop(b.start_min, axis);
  const h = heightPct(b.duration_min || 30, axis);
  const cls = KIND_CLASS[b.kind] || 'dy-personal';
  const icon = KIND_ICON[b.kind] || '•';
  const status = [
    b.overdue ? 'dy-overdue' : '',
    b.running_late ? 'dy-late' : '',
    b.slot_pinned ? 'dy-pinned' : '',
    b.editable && !b.slot_pinned ? 'dy-unlocked' : '',
    b.editable ? 'dy-edit' : 'dy-ro',
    b.is_buffer || b.synthetic ? 'dy-buffer-strip' : '',
  ].filter(Boolean).join(' ');
  const lock = b.slot_pinned
    ? '<span class="dy-lock" aria-label="pinned">🔒</span>'
    : (b.editable ? '<span class="dy-lock-hint" aria-hidden="true">🔒</span>' : '');
  const drag = b.editable && !b.slot_pinned && !b.is_buffer ? 'draggable="true"' : '';
  const label = b.is_buffer || b.synthetic
    ? `${icon} decompress`
    : `${icon} ${b.title}`;
  return `<div class="dy-block ${cls} ${status}"
    style="top:${top}%;height:${h}%"
    data-block-id="${b.id}"
    title="${b.title} (${fmtHm(b.start_min)}–${fmtHm(b.end_min)})"
    ${drag}>
    <div class="dy-block-row">
      <span class="dy-block-label">${label}</span>
      ${priorityTag(b.priority)}
      ${lock}
    </div>
  </div>`;
}

function renderDayColumn(day, blocks, away, axis) {
  const dayBlocks = blocks.filter((b) => b.day === day);
  const awayCls = away ? ' dy-away' : '';
  const awayBanner = away
    ? `<div class="dy-away-label" title="${away.summary || ''}">AWAY</div>`
    : '';
  const hours = [];
  for (let m = axis.start_min; m < axis.end_min; m += 60) {
    hours.push(`<div class="dy-hour" style="top:${minsToTop(m, axis)}%">${fmtHm(m)}</div>`);
  }
  const wd = WEEKDAYS[weekdayIndex(day)];
  return `
    <div class="dy-day${awayCls}" data-day="${day}">
      <div class="dy-day-head sticky">
        <div class="dy-wd">${wd}</div>
        <div class="dy-date">${fmtDayLabel(day)}</div>
      </div>
      <div class="dy-day-grid" data-day="${day}">
        ${awayBanner}
        ${hours.join('')}
        ${dayBlocks.map((b) => renderBlock(b, axis)).join('')}
      </div>
    </div>`;
}

function renderWeek(week, blocks, awayDays, axis) {
  return `
    <div class="dy-week">
      ${week.days.map((d) => renderDayColumn(d, blocks, awayDays[d], axis)).join('')}
    </div>`;
}

function wireDrag(root, data, refresh) {
  const axis = data.day_axis;
  let dragBlock = null;

  root.querySelectorAll('.dy-block.dy-edit').forEach((el) => {
    el.addEventListener('dragstart', (e) => {
      dragBlock = (data.blocks || []).find((b) => b.id === el.dataset.blockId);
      e.dataTransfer.setData('text/plain', el.dataset.blockId);
      e.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const block = (data.blocks || []).find((b) => b.id === el.dataset.blockId);
      if (!block || block.is_buffer || block.synthetic) return;
      if (el.classList.contains('dy-expanded')) {
        showMenu(block, e.clientX, e.clientY, refresh);
      } else {
        root.querySelectorAll('.dy-block.dy-expanded').forEach((x) => x.classList.remove('dy-expanded'));
        el.classList.add('dy-expanded');
      }
    });
  });

  root.querySelectorAll('.dy-day-grid').forEach((grid) => {
    grid.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });
    grid.addEventListener('drop', async (e) => {
      e.preventDefault();
      const day = grid.getAttribute('data-day');
      if (!dragBlock || !day) return;
      const rect = grid.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const span = axis.end_min - axis.start_min;
      let startMin = Math.round((axis.start_min + (y / rect.height) * span) / 15) * 15;
      startMin = Math.max(axis.start_min, Math.min(startMin, axis.end_min - 15));
      const dur = dragBlock.duration_min || 60;
      const endMin = Math.min(startMin + dur, axis.end_min);
      try {
        await dropBlock(dragBlock, day, fmtHm(startMin), fmtHm(endMin), false, refresh);
      } catch (err) {
        alert(err.message || 'Drop failed');
      }
      dragBlock = null;
    });
  });
}

export async function renderDiary() {
  const el = $('view-diary');
  if (!el) return;
  el.innerHTML = '<div class="card"><p class="meta">Loading diary…</p></div>';
  try {
    const data = await api('/api/mc/diary?weeks=4');
    diaryState.data = data;
    const axis = data.day_axis;
    el.innerHTML = `
      ${renderToolbar(data)}
      ${renderLegend()}
      <div class="dy-scroll">
        ${(data.weeks || []).map((w) => renderWeek(w, data.blocks || [], data.away_days || {}, axis)).join('')}
      </div>`;
    wireDrag(el, data, () => renderDiary());
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
