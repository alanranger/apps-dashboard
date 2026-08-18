/**
 * Diary tab — Outlook-style 4-week reschedule grid (UI).
 * DB writes via /api/mc/diary-action; GCal flush via /api/mc/gcal-push (Claude).
 */
import { api } from './api.js';
import { $, esc } from './util.js';
import { openDrawer } from './drawer.js';
import { openRecurringEdit, openMcBusyModal } from './render-recurring.js';
import { applyBootstrap } from './store.js';

const KIND_CLASS = {
  workshop: 'dy-workshop',
  lesson: 'dy-lesson',
  mc_task: 'dy-task',
  habit: 'dy-habit',
  deadline: 'dy-deadline',
  travel: 'dy-travel',
  buffer: 'dy-buffer',
  fixture: 'dy-fixture',
  personal: 'dy-personal',
};

const KIND_ICON = {
  workshop: '📷',
  lesson: '🎓',
  habit: '🔁',
  deadline: '⏰',
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
  toast._t = setTimeout(() => el.classList.remove('show'), 5000);
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

  if (!canCompleteBlock(block) && (block.done || block.read_only || !block.editable)) {
    let why;
    if (block.done) {
      why = block.actual_minutes != null
        ? `Already completed (${block.actual_minutes}m). It stays on the day for the record — you can’t move it.`
        : 'Already completed. It stays on the day for the record — you can’t move it.';
    } else if (block.client_fixed) {
      why = 'Fixed client booking from Google Calendar (workshop / Zoom / 1-2-1). You can’t move it here.';
    } else if (block.gcal_orphan) {
      why = 'Google-only copy (GCAL badge) — not linked to a Diary habit/task, so it can’t be dragged.';
    } else {
      why = 'This comes from Google Calendar (travel, personal, lesson feed, etc.). Only green habits and blue tasks are editable in Diary.';
    }
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
  } else if (block.kind === 'deadline') {
    items.length = 0;
    items.push(['complete', 'Mark complete']);
    items.push(['skip', 'Skip / dismiss reminder']);
  }
  const deadlineNote = block.kind === 'deadline'
    ? '<div class="dy-menu-note">Deadlines can’t be dragged — complete or skip only.</div>'
    : '';
  menu.innerHTML = deadlineNote + items.map(([a, label]) => (
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
      let actual = null;
      if (block.kind === 'deadline') {
        actual = block.duration_min || 20;
      } else {
        actual = askActualMinutes(block);
        if (actual == null) return;
      }
      const ui = openMcBusyModal({
        title: 'Completing diary block',
        doneTitle: 'Complete saved',
        failTitle: 'Complete failed',
        phases: [
          'Mark complete in diary',
          'Auto-sync with Google (can take 20–40s)',
          'Refresh diary',
        ],
      });
      try {
        ui.setPhase(0, 'saving…');
        await api('/api/mc/diary-action', {
          method: 'POST',
          body: {
            action: 'complete',
            kind: block.kind || undefined,
            task_id: block.kind === 'mc_task' ? block.id.replace(/^task:/, '') : undefined,
            habit_id: block.habit_id || undefined,
            hotel_id: block.hotel_id || (block.kind === 'deadline' && String(block.id || '').startsWith('deadline:')
              ? String(block.id).replace(/^deadline:/, '')
              : undefined),
            display_id: block.display_id || undefined,
            completed_at: new Date().toISOString(),
            scheduled_date: block.day || undefined,
            ideal_date: block.ideal_date || block.day || undefined,
            calendar_event_id: block.calendar_event_id || undefined,
            actual_minutes: actual,
          },
        });
        ui.setPhase(1, 'Google sync…');
        try {
          const data = await api('/api/mc/bootstrap');
          applyBootstrap(data);
        } catch (e) { /* Recurring tab refresh best-effort */ }
        ui.setPhase(2, 'refreshing…');
        const doneMsg = block.kind === 'deadline'
          ? 'Deadline complete · moved to now on Google · decompress cleared'
          : `Completed · ${actual}m actual · placed at completion time · Google updated`;
        toast(doneMsg);
        await refresh({ preserveScroll: true });
        ui.finish(doneMsg);
      } catch (err) {
        ui.fail(err);
        throw err;
      }
      return;
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
      if (block.kind === 'deadline') {
        if (!confirm(`Skip / dismiss this reminder?\n${block.title}\n\nRemoves it from Diary and Google.`)) return;
      } else if (!confirm(`Skip this occurrence only?\n${block.title}\n\nRemoves it from this day. Next scheduled occurrence still appears.`)) {
        return;
      }
      const ui = openMcBusyModal({
        title: 'Skipping diary occurrence',
        doneTitle: 'Skip complete',
        failTitle: 'Skip failed',
        phases: [
          'Remove occurrence from diary',
          'Auto-sync with Google (can take 20–40s)',
          'Refresh diary',
        ],
      });
      try {
        ui.setPhase(0, 'saving…');
        if (block.kind === 'deadline') {
          await api('/api/mc/diary-action', {
            method: 'POST',
            body: {
              action: 'skip',
              kind: 'deadline',
              hotel_id: block.hotel_id || (String(block.id || '').startsWith('deadline:')
                ? String(block.id).replace(/^deadline:/, '')
                : undefined),
              calendar_event_id: block.calendar_event_id || undefined,
              scheduled_date: block.day,
            },
          });
        } else {
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
        }
        ui.setPhase(1, 'Google sync…');
        const doneMsg = block.kind === 'deadline'
          ? 'Reminder dismissed · removing from Google'
          : 'Skipped this occurrence · next cycle still schedules';
        toast(doneMsg);
        ui.setPhase(2, 'refreshing…');
        await refresh({ preserveScroll: true });
        ui.finish(doneMsg);
      } catch (err) {
        ui.fail(err);
        throw err;
      }
      return;
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
    await refresh({ preserveScroll: true });
  } catch (err) {
    alert(err.message || 'Action failed');
  }
}

function canCompleteBlock(b) {
  if (!b || b.done || b.is_buffer || b.synthetic) return false;
  if (b.kind === 'habit' && b.habit_id) return true;
  if (b.kind === 'deadline' && b.editable) return true;
  if (b.kind === 'mc_task' && b.editable && !b.gcal_orphan) return true;
  return false;
}

function resolveDiaryMove(block) {
  if (!block || block.done || block.gcal_orphan || block.is_buffer || block.synthetic || block.client_fixed) {
    return null;
  }
  const id = String(block.id || '');
  if (block.kind === 'mc_task' || id.startsWith('task:')) {
    const taskId = id.startsWith('task:') ? id.slice(5) : id;
    if (!taskId) return null;
    return { kind: 'mc_task', task_id: taskId };
  }
  if (block.kind === 'habit' || id.startsWith('habit:')) {
    const fromId = id.match(/^habit:([^:]+):/);
    const habitId = block.habit_id || (fromId ? fromId[1] : null);
    if (!habitId) return null;
    return {
      kind: 'habit',
      habit_id: habitId,
      ideal_date: block.ideal_date || block.day || null,
    };
  }
  return null;
}

async function dropBlock(block, day, startHm, endHm, override, refresh, destLabel) {
  if (dropBlock._busy) return;
  dropBlock._busy = true;
  const where = destLabel || `${fmtDayLabel(day)} · ${startHm}–${endHm}`;
  const ui = openMcBusyModal({
    title: 'Moving diary block',
    doneTitle: 'Move complete',
    failTitle: 'Move failed',
    phases: [
      'Save new slot in diary',
      'Queue Google Calendar update',
      'Auto-sync with Google (can take 20–40s)',
      'Refresh diary',
    ],
  });
  try {
    ui.setPhase(0, `moving to ${where}…`);
    const target = resolveDiaryMove(block);
    if (!target) {
      const kind = block?.kind || 'unknown';
      ui.fail(new Error(
        kind === 'deadline'
          ? 'Hotel deadlines can’t be dragged — use ☐ complete or Skip from the menu.'
          : `Only green habits and blue tasks can be dragged (this is “${kind}”).`,
      ));
      return;
    }
    const body = {
      action: 'move',
      new_start: londonYmdHmToIso(day, startHm),
      new_end: londonYmdHmToIso(day, endHm),
      title: block.title,
      override: !!override,
      calendar_event_id: block.calendar_event_id || undefined,
    };
    if (target.kind === 'mc_task') {
      body.task_id = target.task_id;
      body.unlock_if_pinned = true;
    } else {
      body.habit_id = target.habit_id;
      body.ideal_date = target.ideal_date;
    }
    let res = await api('/api/mc/diary-action', { method: 'POST', body });
    if (res.needs_override) {
      const msg = `Warnings:\n- ${res.warnings.join('\n- ')}\n\nOverride and place anyway?`;
      if (!confirm(msg)) {
        ui.fail(new Error('Move cancelled (override declined)'));
        return;
      }
      ui.setPhase(1, 'overriding warnings…');
      body.override = true;
      res = await api('/api/mc/diary-action', { method: 'POST', body });
    }
    ui.setPhase(2, 'Google sync…');
    const writes = res?.calendar_writes ?? 0;
    ui.setPhase(3, 'refreshing…');
    toast(`Moved to ${where} · saved to DB`);
    await refresh({ preserveScroll: true });
    ui.finish(
      writes > 0
        ? `Moved to ${where} and synced to Google (${writes} write${writes === 1 ? '' : 's'}).`
        : `Moved to ${where}. Google sync skipped or had nothing to write.`,
    );
  } catch (err) {
    ui.fail(err);
    toast(err.message || 'Move failed');
  } finally {
    dropBlock._busy = false;
  }
}

function renderLegend() {
  const editable = [
    ['dy-task', '📋', 'Manual task', 'drag · ☐ complete · amend'],
    ['dy-habit', '🔁', 'Recurring habit', 'drag · ☐ complete · amend'],
    ['dy-deadline', '⏰', 'Hotel / room deadline', '☐ complete · skip'],
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
      <p class="meta dy-leg-note">Blue tasks, green habits &amp; amber deadlines. Locked 🔒 client bookings cannot move.</p>
    </div>`;
}

function renderToolbar(data) {
  const push = data.push || {};
  const openN = push.open_count || 0;
  const backlogN = push.backlog_count || 0;
  const actionable = Number(push.actionable_count != null ? push.actionable_count : openN);
  const skipped = Number(push.skipped_count || 0);
  const qs = push.queue_summary || {};
  const bd = qs.breakdown || {};
  const samples = Array.isArray(qs.samples) ? qs.samples : [];
  const enabled = !!push.cursor_writes_available || !!push.writes_available;
  const autoOn = !!push.auto_sync_enabled;
  const signed = !!push.auto_sync_signed_off;
  const pushTone = !actionable ? 'dy-push-idle' : enabled ? 'dy-push-go' : 'dy-push-blocked';
  const driftN = Number(data.gcal_drift_count || 0);
  const statusLabel = !enabled
    ? 'Cursor GCal not configured'
    : autoOn && signed
      ? (actionable ? 'Auto-sync on · writes waiting' : 'Auto-sync on · nothing to write')
      : (actionable ? 'Manual Push ready (auto-sync gated)' : 'Nothing actionable · auto-sync gated');
  const driftNote = driftN > 0
    ? `<p class="dy-drift-banner"><strong>${driftN} block${driftN === 1 ? '' : 's'} differ from Google</strong> —
        Amber <strong>PUSH</strong> = you moved it here (hit Push). <strong>OUT OF SYNC</strong> = Google time shown until you pin/drag.</p>`
    : `<p class="meta dy-edit-hint">Drag blue/green to move · then <strong>Push</strong> so Google matches. Diary keeps your move visible until then.</p>`;
  const reconcileLine = push.reconcile_status
    ? `<p class="meta dy-reconcile-line"><strong>${esc(push.reconcile_status)}</strong>${
      push.reconcile_at ? ` · checked ${esc(String(push.reconcile_at).slice(0, 19).replace('T', ' '))}Z` : ''
    }</p>`
    : '';
  const kindBits = [
    bd.skip ? `${bd.skip} remove/skip` : '',
    bd.move ? `${bd.move} move/create` : '',
    bd.complete ? `${bd.complete} complete` : '',
    bd.other ? `${bd.other} other` : '',
  ].filter(Boolean).join(' · ');
  const placerBit = bd.placer
    ? `<strong>${bd.placer}</strong> from today’s Scheduling / habit placer (not hand-dragged Diary edits).`
    : 'No placer rows in the queue.';
  const sampleHtml = samples.length
    ? `<ul class="dy-push-samples">${samples.map((s) =>
      `<li><span class="dy-push-kind">${esc(s.kind || '')}</span> ${esc(s.what || '')}</li>`,
    ).join('')}</ul>`
    : '<p class="meta">Queue is empty.</p>';
  return `
    <div class="dy-toolbar card">
      <div class="dy-toolbar-top">
        <div>
          <strong>Diary</strong>
          <span class="meta"> · Mon–Sun · 8 weeks · 30-min axis · ${data.from} → ${data.to}
            · baseline Google</span>
        </div>
        <button type="button" class="btn-secondary" data-dy-refresh>Refresh</button>
      </div>
      ${driftNote}
      ${reconcileLine}
      <div class="dy-push-panel ${pushTone}">
        <div class="dy-push-panel-head">
          <span class="dy-push-kicker">Google Calendar sync</span>
          <span class="dy-push-status">${statusLabel}</span>
        </div>
        <div class="dy-push-panel-body">
          <div class="dy-push-counts">
            <div class="dy-push-count">
              <strong>${actionable}</strong>
              <span>will write</span>
            </div>
            <div class="dy-push-count">
              <strong>${openN}</strong>
              <span>queued writes</span>
            </div>
            <div class="dy-push-count">
              <strong>${skipped}</strong>
              <span>skipped (stale)</span>
            </div>
          </div>
          <p class="dy-push-breakdown">${kindBits || 'Nothing queued'}. ${placerBit}</p>
          ${sampleHtml}
          <button type="button" class="dy-push-btn" data-dy-push ${enabled && actionable ? '' : 'disabled'}
            title="${enabled
    ? 'Writes whatever is in the queue (see list above) to Google via Cursor.'
    : 'Blocked until Google Calendar OAuth is configured.'}">
            ${enabled
    ? (actionable ? `Push ${actionable} queued write${actionable === 1 ? '' : 's'} to Google` : 'Nothing to push')
    : `Blocked · ${actionable} actionable`}
          </button>
        </div>
        <p class="dy-push-explain">
          Only push when you recognise the list above.
          Raw Scheduling detector proposals are separate until dismissed.
          Auto-sync: ${autoOn ? 'ON' : 'OFF'} · sign-off: ${signed ? 'done' : 'pending dry-run approval'}.
        </p>
      </div>
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

function isMovableDiaryBlock(b) {
  return !!(b && !b.done && !b.is_buffer && !b.synthetic && !b.gcal_orphan
    && (b.kind === 'habit' || b.kind === 'mc_task'));
}

/** Mark overlaps that need action (habit/task vs something). Personal×personal is not CONFLICT. */
function conflictIds(dayBlocks) {
  const timed = (dayBlocks || [])
    .filter((b) => !b.is_buffer && !b.synthetic && !b.done
      && (b.end_min || 0) > (b.start_min || 0));
  const bad = new Set();
  for (let i = 0; i < timed.length; i += 1) {
    for (let j = i + 1; j < timed.length; j += 1) {
      const a = timed[i];
      const b = timed[j];
      if (!(a.start_min < b.end_min && b.start_min < a.end_min)) continue;
      // Pure calendar noise (CT Scan vs Camera setup, etc.) — not something Drag can fix.
      if (!isMovableDiaryBlock(a) && !isMovableDiaryBlock(b) && !a.gcal_orphan && !b.gcal_orphan) {
        continue;
      }
      bad.add(a.id);
      bad.add(b.id);
    }
  }
  return bad;
}

/** Side lanes so overlapping editable blocks stay grabbable. */
function conflictLanes(dayBlocks, conflictSet) {
  const lanes = new Map();
  const timed = (dayBlocks || [])
    .filter((b) => conflictSet?.has(b.id) && (b.kind === 'mc_task' || b.kind === 'habit'))
    .sort((a, b) => (a.start_min - b.start_min) || (a.end_min - b.end_min)
      || String(a.id).localeCompare(String(b.id)));
  for (const b of timed) {
    let lane = 0;
    for (;; lane += 1) {
      const hit = timed.some((o) => o !== b && lanes.get(o.id) === lane
        && o.start_min < b.end_min && b.start_min < o.end_min);
      if (!hit) break;
    }
    lanes.set(b.id, lane);
  }
  return lanes;
}

function renderBlock(b, axis, conflicts, lane = 0) {
  const top = minsToTop(b.start_min, axis);
  const h = heightPct(b.duration_min || 30, axis);
  const cls = KIND_CLASS[b.kind] || 'dy-personal';
  const icon = KIND_ICON[b.kind] || '•';
  // Tasks: slot_pinned = user lock. Habits: no lock icon for ordinary diary pins.
  const locked = !!(b.client_fixed || (b.kind === 'mc_task' && b.slot_pinned));
  const isBuffer = !!(b.is_buffer || b.synthetic);
  const done = !!b.done;
  const tall = (b.duration_min || 30) >= 90 ? 'dy-tall' : '';
  const conflict = conflicts?.has(b.id) ? 'dy-conflict' : '';
  const canEdit = !!(b.editable && !isBuffer && !done && !b.gcal_orphan);
  // Allow drag even when task is pinned — drop will unlock. Client-fixed / deadlines stay undragged.
  const canDrag = !!(canEdit && !b.client_fixed && resolveDiaryMove(b));
  const canComplete = canCompleteBlock(b);
  const status = [
    b.overdue ? 'dy-overdue' : '',
    b.running_late ? 'dy-late' : '',
    locked ? 'dy-pinned' : '',
    b.editable && !locked ? 'dy-unlocked' : '',
    canDrag ? 'dy-edit' : 'dy-ro',
    isBuffer ? 'dy-buffer-strip' : '',
    b.client_fixed ? 'dy-client-fixed' : '',
    done ? 'dy-done-block' : '',
    b.out_of_sync ? 'dy-oos' : '',
    b.gcal_orphan ? 'dy-gcal-orphan' : '',
    stackClass(b.kind, isBuffer),
    conflict,
    tall,
    lane > 0 ? `dy-lane-${Math.min(lane, 2)}` : '',
  ].filter(Boolean).join(' ');
  const tipBits = [
    `${b.title} (${fmtHm(b.start_min)}–${fmtHm(b.end_min)})`,
    b.gcal_baseline ? 'Time from Google Calendar' : '',
    b.awaiting_push ? 'Moved in Diary — Push to update Google' : '',
    b.out_of_sync && !b.awaiting_push ? '⚠ DB pin differs from Google — showing Google' : '',
    b.gcal_orphan ? 'On Google only (not linked in MC DB) — Push to clear duplicates' : '',
    conflict ? '⚠ Overlap with fixed time — drag habit/task clear of it' : '',
    done && b.actual_minutes != null ? `Completed · ${b.actual_minutes}m actual · can’t move` : '',
    done && b.actual_minutes == null ? 'Completed · can’t move' : '',
    b.client_fixed ? 'Fixed client booking · can’t move' : '',
    canDrag ? 'Drag to reschedule · click for menu' : '',
    canEdit && locked ? 'Pinned — drag still moves (unlocks)' : '',
    !canEdit && !done && !b.client_fixed ? 'From Google Calendar · not editable here' : '',
  ].filter(Boolean);
  const lock = locked
    ? '<span class="dy-lock" aria-label="pinned">🔒</span>'
    : '';
  const doneBtn = canComplete && (b.kind === 'mc_task' || b.kind === 'habit' || b.kind === 'deadline')
    ? `<button type="button" class="dy-done" data-dy-done title="Mark complete">☐</button>`
    : '';
  const grab = canDrag
    ? '<span class="dy-grab" title="Drag to move" aria-hidden="true">⠿</span>'
    : '';
  const editBadge = canDrag
    ? '<span class="dy-edit-badge" title="Editable — drag to move">DRAG</span>'
    : '';
  const doneBadge = done
    ? `<span class="dy-done-badge">DONE${b.actual_minutes != null ? ` ${b.actual_minutes}m` : ''}</span>`
    : '';
  const conflictBadge = conflict ? '<span class="dy-conflict-badge">CONFLICT</span>' : '';
  const oosBadge = b.awaiting_push
    ? '<span class="dy-oos-badge" title="Moved here — Push to update Google">PUSH</span>'
    : (b.out_of_sync ? '<span class="dy-oos-badge" title="DB pin differs from Google">OUT OF SYNC</span>' : '');
  const missingBadge = b.gcal_missing
    ? '<span class="dy-oos-badge" title="Pin points at a missing Google event — run Full Horizon / Push">MISSING GCAL</span>'
    : '';
  const orphanBadge = b.gcal_orphan ? '<span class="dy-orphan-badge" title="Google only">GCAL</span>' : '';
  const label = isBuffer
    ? (b.title && !/^decompress$/i.test(String(b.title).trim())
      ? `<span class="dy-type-icon" aria-hidden="true">${KIND_ICON.buffer}</span> ${b.title}`
      : `${KIND_ICON.buffer} decompress`)
    : `<span class="dy-type-icon" aria-hidden="true">${icon}</span> ${b.title}`;
  return `<div class="dy-block ${cls} ${status}"
    style="top:${top}%;height:${h}%"
    data-block-id="${b.id}"
    title="${tipBits.join(' · ')}">
    <div class="dy-block-row">
      ${grab}
      ${doneBtn}
      <span class="dy-block-label">${label}</span>
      ${editBadge}
      ${doneBadge}
      ${oosBadge}
      ${missingBadge}
      ${orphanBadge}
      ${conflictBadge}
      ${priorityTag(b.priority)}
      ${lock}
    </div>
  </div>`;
}

function renderAwayOverlays(day, overlays, away, axis) {
  if (away?.kind === 'away_span') return '';
  return (overlays || [])
    .filter((o) => o.day === day && o.end_min > o.start_min)
    .map((o) => {
      const top = minsToTop(o.start_min, axis);
      const h = heightPct(o.end_min - o.start_min, axis);
      return `<div class="dy-away-partial" style="top:${top}%;height:${h}%"
        title="Away — between travel out and travel home"></div>`;
    })
    .join('');
}

function renderDayColumn(day, blocks, away, axis, banners, holidayTitle, overlays) {
  const dayBlocks = blocks.filter((b) => b.day === day);
  const dayDrift = dayBlocks.filter((b) => b.out_of_sync).length;
  const conflicts = conflictIds(dayBlocks);
  const lanes = conflictLanes(dayBlocks, conflicts);
  const kind = away?.kind || (away ? 'away_span' : null);
  const isAway = kind === 'away_span';
  const isRest = kind === 'rest_after_workshop' || kind === 'rest_after_away';
  const isTeaching = kind === 'teaching_day';
  const dayCls = [
    isAway ? 'dy-away' : '',
    isRest ? 'dy-rest' : '',
    isTeaching ? 'dy-teaching' : '',
    holidayTitle ? 'dy-bh' : '',
    dayDrift ? 'dy-day-oos' : '',
  ].filter(Boolean).map((c) => ` ${c}`).join('');
  const statusBanner = isAway
    ? `<div class="dy-away-label" title="${away.summary || ''}">AWAY</div>`
    : isRest
      ? `<div class="dy-rest-label" title="${away.summary || ''}">REST</div>`
      : '';
  const oosBanner = dayDrift
    ? `<div class="dy-day-oos-label" title="DB pin differs from Google">${dayDrift} out of sync</div>`
    : '';
  const bhBadge = holidayTitle
    ? `<div class="dy-bh-badge" title="${holidayTitle}">BANK HOLIDAY</div>`
    : '';
  const dayBanners = (banners || [])
    .filter((b) => b.day === day)
    .map((b) => `<div class="dy-allday" title="${b.title}">${b.title}</div>`)
    .join('');
  const wd = WEEKDAYS[weekdayIndex(day)];
  return `
    <div class="dy-day${dayCls}" data-day="${day}">
      <div class="dy-day-head">
        <div class="dy-wd">${wd}</div>
        <div class="dy-date">${fmtDayLabel(day)}</div>
        ${bhBadge}
        ${oosBanner}
      </div>
      <div class="dy-day-grid" data-day="${day}"
        style="height:${axis.grid_px || 1152}px;--dy-step:${axis.px_per_step || 36}px">
        ${dayBanners ? `<div class="dy-allday-stack">${dayBanners}</div>` : ''}
        ${statusBanner}
        ${renderAwayOverlays(day, overlays, away, axis)}
        ${dayBlocks.map((b) => renderBlock(b, axis, conflicts, lanes.get(b.id) || 0)).join('')}
      </div>
    </div>`;
}

function renderTimeGutter(axis) {
  const ticks = [];
  const step = axis.step_min || 30;
  for (let m = axis.start_min; m < axis.end_min; m += step) {
    const half = m % 60 !== 0;
    ticks.push(
      `<div class="dy-time-tick${half ? ' dy-time-tick-half' : ''}" style="top:${minsToTop(m, axis)}%">${fmtHm(m)}</div>`,
    );
  }
  return `
    <div class="dy-time-gutter" aria-hidden="true">
      <div class="dy-time-gutter-head">Time</div>
      <div class="dy-time-gutter-grid" style="height:${axis.grid_px || 1152}px;--dy-step:${axis.px_per_step || 36}px">
        ${ticks.join('')}
      </div>
    </div>`;
}

function fmtHours(mins) {
  const h = Math.round((mins / 60) * 10) / 10;
  return `${h}h`;
}

function weekHumanTip(cap) {
  const pct = cap.pct || 0;
  const freeH = Math.round(((cap.free_min || 0) / 60) * 10) / 10;
  const mov = cap.movable_h || 0;
  if (cap.over || pct >= 100) {
    return mov > 0
      ? `Maxed — move or skip ${mov}h of green/blue (habits/tasks)`
      : 'Maxed — fixed load owns this week (away / teaching / calendar)';
  }
  if (pct >= 90) {
    return mov > 0
      ? `Nearly full — only shift habits/tasks (${mov}h movable)`
      : 'Nearly full — little you can move; protect rest';
  }
  if (pct >= 75) {
    return `Tight — ${freeH}h realistic free; don’t pack evenings`;
  }
  if ((cap.away_days || 0) >= 3) {
    return `Heavy away week — keep post-residential Monday clear`;
  }
  if (freeH >= 8) {
    return `Breathing room — ${freeH}h free for habits/tasks`;
  }
  return `${freeH}h free (realistic)`;
}

function renderHorizonBoard(weeks, landIdx = 0) {
  const tiles = (weeks || []).map((w, i) => {
    const cap = w.capacity || {};
    const pct = Math.min(100, cap.pct || 0);
    const tone = cap.over || pct >= 95 ? 'dy-hz-hot' : pct >= 75 ? 'dy-hz-warm' : 'dy-hz-ok';
    const land = i === landIdx ? ' dy-hz-land' : '';
    const start = w.days?.[0] || '';
    const end = w.days?.[6] || '';
    const tip = weekHumanTip(cap);
    const bh = cap.breakdown_h || {};
    const bits = [
      bh.habit ? `Habits ${bh.habit}h` : '',
      bh.deadline ? `Deadlines ${bh.deadline}h` : '',
      bh.task ? `Tasks ${bh.task}h` : '',
      bh.away ? `Away ${bh.away}h` : '',
      bh.workshop ? `Client ${bh.workshop}h` : '',
      bh.lesson ? `Lesson ${bh.lesson}h` : '',
      bh.travel ? `Travel ${bh.travel}h` : '',
      bh.fixture ? `Fixture ${bh.fixture}h` : '',
      bh.personal ? `Personal ${bh.personal}h` : '',
      bh.buffer ? `Buffer ${bh.buffer}h` : '',
    ].filter(Boolean).join(' · ');
    return `
      <button type="button" class="dy-hz-tile ${tone}${land}" data-dy-jump-week="${i}"
        title="${cap.label || ''} — ${tip}">
        <div class="dy-hz-week">W${i + 1} · ${fmtDayLabel(start)}–${fmtDayLabel(end)}</div>
        <div class="dy-hz-pct">${pct}%</div>
        <div class="dy-hz-bar"><span style="width:${pct}%"></span></div>
        <div class="dy-hz-split">
          <span class="dy-hz-fix" title="Away, workshops, lessons, travel, personal, fixtures, buffers">Fixed ${cap.fixed_h || 0}h</span>
          <span class="dy-hz-move" title="Green habits + blue tasks — what you can still move">Movable ${cap.movable_h || 0}h</span>
        </div>
        <div class="dy-hz-free">${fmtHours(cap.free_min || 0)} free</div>
        <div class="dy-hz-tip">${tip}</div>
        ${bits ? `<div class="dy-hz-bits meta">${bits}</div>` : ''}
      </button>`;
  }).join('');
  return `
    <div class="dy-horizon card">
      <div class="dy-horizon-head">
        <strong>8-week capacity</strong>
        <span class="meta">Committed vs realistic · Fixed = calendar/away · Movable = habits + tasks · click a week to jump</span>
      </div>
      <div class="dy-horizon-grid">${tiles}</div>
    </div>`;
}

function renderWeekBreakdown(cap) {
  const rows = [
    ['away', 'Away', 'dy-travel'],
    ['workshop', 'Client / workshop', 'dy-workshop'],
    ['lesson', 'Lesson', 'dy-lesson'],
    ['travel', 'Travel', 'dy-travel'],
    ['habit', 'Habits', 'dy-habit'],
    ['deadline', 'Deadlines', 'dy-deadline'],
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
        <span class="meta" title="Locked calendar / away">Fixed ${cap.fixed_h || 0}h</span>
        <span class="meta" title="Habits + tasks you can drag">Movable ${cap.movable_h || 0}h</span>
        ${awayN ? `<span class="meta">${awayN} away</span>` : ''}
        ${teachN ? `<span class="meta">${teachN} teaching</span>` : ''}
      </div>
      <div class="dy-fuel-track" aria-hidden="true">
        <div class="dy-fuel-fill" style="width:${pct}%"></div>
      </div>
      ${renderWeekBreakdown(cap)}
    </div>`;
}

function renderWeek(week, blocks, awayDays, axis, banners, holidays, overlays) {
  return `
    <div class="dy-week-wrap">
      ${renderWeekGauge(week)}
      <div class="dy-week">
        ${renderTimeGutter(axis)}
        ${week.days.map((d) => renderDayColumn(
    d, blocks, awayDays[d], axis, banners, holidays?.[d], overlays,
  )).join('')}
      </div>
    </div>`;
}

function minsFromPointerY(grid, clientY, axis) {
  const rect = grid.getBoundingClientRect();
  const span = axis.end_min - axis.start_min;
  const step = axis.step_min || 30;
  let startMin = Math.round((axis.start_min + ((clientY - rect.top) / rect.height) * span) / step) * step;
  return Math.max(axis.start_min, Math.min(startMin, axis.end_min - step));
}

function dropSlot(grid, clientY, axis, durMin) {
  const startMin = minsFromPointerY(grid, clientY, axis);
  const endMin = Math.min(startMin + (durMin || 60), axis.end_min);
  return { startMin, endMin, top: minsToTop(startMin, axis), height: heightPct(endMin - startMin, axis) };
}

function clearDropUi(root) {
  root.querySelectorAll('.dy-drop-target').forEach((g) => g.classList.remove('dy-drop-target'));
  root.querySelectorAll('.dy-drop-preview').forEach((p) => p.remove());
}

function showDropPreview(root, grid, clientY, axis, durMin) {
  clearDropUi(root);
  if (!grid) return null;
  grid.classList.add('dy-drop-target');
  const slot = dropSlot(grid, clientY, axis, durMin);
  const preview = document.createElement('div');
  preview.className = 'dy-drop-preview';
  preview.style.top = `${slot.top}%`;
  preview.style.height = `${slot.height}%`;
  preview.innerHTML = `<span class="dy-drop-time">${fmtHm(slot.startMin)}–${fmtHm(slot.endMin)}</span>`;
  grid.appendChild(preview);
  return slot;
}

function wireDiary(root, data, refresh) {
  const axis = data.day_axis || { start_min: 300, end_min: 1380, step_min: 30 };
  // Re-paint replaces innerHTML but keeps listeners on root — update refs only.
  root._dyData = data;
  root._dyRefresh = refresh;
  root._dyAxis = axis;
  if (root._dyWired) return;
  root._dyWired = true;

  let dragStarted = false;
  let ptr = null;

  function live() {
    return {
      data: root._dyData || { blocks: [] },
      refresh: root._dyRefresh || (async () => {}),
      axis: root._dyAxis || { start_min: 300, end_min: 1380, step_min: 30 },
    };
  }

  function clearDrag() {
    ptr?.ghost?.remove();
    if (ptr?.el) ptr.el.classList.remove('dy-drag-source');
    clearDropUi(root);
    root.classList.remove('dy-dragging');
    ptr = null;
  }

  function positionGhost(clientX, clientY) {
    if (!ptr?.ghost) return;
    ptr.ghost.style.left = `${clientX - ptr.offX}px`;
    ptr.ghost.style.top = `${clientY - ptr.offY}px`;
  }

  function dayGridUnderPoint(clientX, clientY) {
    const stack = typeof document.elementsFromPoint === 'function'
      ? document.elementsFromPoint(clientX, clientY)
      : [document.elementFromPoint(clientX, clientY)].filter(Boolean);
    for (const el of stack) {
      if (!el || el.classList?.contains('dy-drag-ghost')) continue;
      const grid = el.classList?.contains('dy-day-grid')
        ? el
        : el.closest?.('.dy-day-grid');
      if (grid && root.contains(grid)) return grid;
    }
    return null;
  }

  root.addEventListener('click', async (e) => {
    const { data: d, refresh: r } = live();
    const blockEl = e.target.closest('.dy-block');
    if (!blockEl || !root.contains(blockEl)) return;
    e.preventDefault();
    e.stopPropagation();
    if (dragStarted) {
      dragStarted = false;
      return;
    }
    const block = (d.blocks || []).find((b) => b.id === blockEl.dataset.blockId);
    if (!block || block.is_buffer || block.synthetic) return;

    if (e.target.closest('[data-dy-done]')) {
      if (!canCompleteBlock(block)) return;
      try {
        await runMenuAction('complete', block, r);
      } catch (err) {
        alert(err.message || 'Complete failed');
      }
      return;
    }

    blockEl.classList.add('dy-expanded');
    showMenu(block, e.clientX, e.clientY, r);
  });

  root.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('[data-dy-done], .dy-menu, a, input, textarea, select')) return;
    const anyBlock = e.target.closest('.dy-block');
    const blockEl = e.target.closest('.dy-block.dy-edit');
    if (!blockEl || !root.contains(blockEl)) {
      // Explain why a non-draggable block won’t move (deadlines / GCAL orphans / locked).
      if (anyBlock && root.contains(anyBlock) && !anyBlock.classList.contains('dy-edit')) {
        const { data: d } = live();
        const block = (d.blocks || []).find((b) => b.id === anyBlock.dataset.blockId);
        if (block?.kind === 'deadline') {
          toast('Hotel deadlines can’t be dragged — click for Complete / Skip');
        } else if (block?.gcal_orphan && !canCompleteBlock(block)) {
          toast('GCAL-only copy — not linked in Diary, so it can’t be dragged');
        } else if (block?.client_fixed || block?.kind === 'workshop' || block?.kind === 'lesson') {
          toast('Locked client / workshop time — can’t drag');
        }
      }
      return;
    }
    const { data: d } = live();
    const block = (d.blocks || []).find((b) => b.id === blockEl.dataset.blockId);
    if (!block || !resolveDiaryMove(block)) return;
    const r = blockEl.getBoundingClientRect();
    ptr = {
      block,
      el: blockEl,
      x0: e.clientX,
      y0: e.clientY,
      offX: e.clientX - r.left,
      offY: e.clientY - r.top,
      moved: false,
      ghost: null,
      pid: e.pointerId,
      slot: null,
    };
    try { blockEl.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
  });

  root.addEventListener('pointermove', (e) => {
    if (!ptr || e.pointerId !== ptr.pid) return;
    const { axis: ax } = live();
    const dx = e.clientX - ptr.x0;
    const dy = e.clientY - ptr.y0;
    if (!ptr.moved && (dx * dx + dy * dy) < 36) return;
    if (!ptr.moved) {
      ptr.moved = true;
      dragStarted = true;
      root.classList.add('dy-dragging');
      ptr.el.classList.add('dy-drag-source');
      const r = ptr.el.getBoundingClientRect();
      const ghost = ptr.el.cloneNode(true);
      ghost.classList.add('dy-drag-ghost');
      ghost.removeAttribute('data-block-id');
      ghost.style.position = 'fixed';
      ghost.style.right = 'auto';
      ghost.style.width = `${r.width}px`;
      ghost.style.height = `${r.height}px`;
      document.body.appendChild(ghost);
      ptr.ghost = ghost;
      positionGhost(e.clientX, e.clientY);
    }
    e.preventDefault();
    positionGhost(e.clientX, e.clientY);
    const grid = dayGridUnderPoint(e.clientX, e.clientY);
    ptr.grid = grid;
    ptr.day = grid?.getAttribute('data-day') || null;
    const dur = ptr.block.duration_min || 60;
    ptr.slot = showDropPreview(root, grid, e.clientY, ax, dur);
  });

  root.addEventListener('pointerup', async (e) => {
    if (!ptr || e.pointerId !== ptr.pid) return;
    const { refresh: r } = live();
    const wasDrag = ptr.moved;
    const block = ptr.block;
    const slot = ptr.slot;
    const day = ptr.day;
    clearDrag();
    if (!wasDrag) return;
    setTimeout(() => { dragStarted = false; }, 0);
    if (!day || !slot) {
      toast('Drop on a day column to reschedule');
      return;
    }
    try {
      await dropBlock(
        block,
        day,
        fmtHm(slot.startMin),
        fmtHm(slot.endMin),
        false,
        r,
        `${fmtDayLabel(day)} · ${fmtHm(slot.startMin)}–${fmtHm(slot.endMin)}`,
      );
    } catch (err) {
      alert(err.message || 'Drop failed');
    }
  });

  root.addEventListener('pointercancel', (e) => {
    if (!ptr || e.pointerId !== ptr.pid) return;
    clearDrag();
    setTimeout(() => { dragStarted = false; }, 0);
  });
}

/** Index of week to land on: current week, or next week from Fri–Sun (today-forward). */
function landingWeekIndex(weeks, todayYmd) {
  const weeksArr = weeks || [];
  if (!weeksArr.length) return 0;
  let idx = weeksArr.findIndex((w) => (w.days || []).includes(todayYmd));
  if (idx < 0) idx = 0;
  const days = weeksArr[idx]?.days || [];
  const pos = days.indexOf(todayYmd); // 0=Mon … 6=Sun
  if (pos >= 4 && weeksArr[idx + 1]) return idx + 1;
  return idx;
}

function scrollToWeek(root, idx) {
  const wraps = root.querySelectorAll('.dy-week-wrap');
  wraps[idx]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function paintDiary(el, opts = {}) {
  const preserveScroll = !!opts.preserveScroll;
  const scrollEl = el.querySelector('.dy-scroll');
  const prevScroll = preserveScroll && scrollEl ? scrollEl.scrollTop : null;
  const keepWeekIdx = preserveScroll && diaryState.weekIdx != null ? diaryState.weekIdx : null;

  if (!preserveScroll) {
    el.innerHTML = '<div class="card"><p class="meta">Loading diary…</p></div>';
  }

  const data = await api('/api/mc/diary?weeks=8');
  diaryState.data = data;
  const axis = data.day_axis;
  const today = data.today || new Date().toISOString().slice(0, 10);
  const landIdx = landingWeekIndex(data.weeks || [], today);
  let weekIdx = keepWeekIdx != null ? keepWeekIdx : landIdx;
  const jumpDay = sessionStorage.getItem('mc_jump_day');
  if (jumpDay && !preserveScroll) {
    sessionStorage.removeItem('mc_jump_day');
    const jumpWeek = (data.weeks || []).findIndex((w) => (w.days || []).includes(jumpDay));
    if (jumpWeek >= 0) weekIdx = jumpWeek;
  }
  weekIdx = Math.max(0, Math.min((data.weeks || []).length - 1, weekIdx));
  diaryState.weekIdx = weekIdx;

  el.innerHTML = `
      ${renderToolbar(data)}
      ${renderLegend()}
      ${renderHorizonBoard(data.weeks || [], weekIdx)}
      <div class="dy-week-nav">
        <button type="button" class="btn-secondary" data-dy-week-prev title="Previous week">‹ Prev week</button>
        <span class="meta">Landing on actionable week · use tiles or arrows to page</span>
        <button type="button" class="btn-secondary" data-dy-week-next title="Next week">Next week ›</button>
      </div>
      <div class="dy-scroll">
        ${(data.weeks || []).map((w) => renderWeek(
    w, data.blocks || [], data.away_days || {}, axis,
    data.day_banners || [], data.holidays || {}, data.away_overlays || [],
  )).join('')}
      </div>`;
  wireDiary(el, data, (refreshOpts) => paintDiary(el, refreshOpts));

  const jump = (idx) => {
    weekIdx = Math.max(0, Math.min((data.weeks || []).length - 1, idx));
    diaryState.weekIdx = weekIdx;
    scrollToWeek(el, weekIdx);
    el.querySelectorAll('[data-dy-jump-week]').forEach((btn) => {
      btn.classList.toggle('dy-hz-land', Number(btn.getAttribute('data-dy-jump-week')) === weekIdx);
    });
  };
  el.querySelectorAll('[data-dy-jump-week]').forEach((btn) => {
    btn.addEventListener('click', () => jump(Number(btn.getAttribute('data-dy-jump-week'))));
  });
  el.querySelector('[data-dy-week-prev]')?.addEventListener('click', () => jump(weekIdx - 1));
  el.querySelector('[data-dy-week-next]')?.addEventListener('click', () => jump(weekIdx + 1));

  requestAnimationFrame(() => {
    const scroller = el.querySelector('.dy-scroll');
    if (preserveScroll && prevScroll != null && scroller) {
      scroller.scrollTop = prevScroll;
    } else {
      jump(weekIdx);
    }
  });
}

export async function renderDiary() {
  const el = $('view-diary');
  if (!el) return;
  try {
    await paintDiary(el);
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
      toast('Push disabled — nothing actionable or GCal not configured');
      return true;
    }
    await runPushToGoogleWithModal(btn, refresh);
    return true;
  }
  if (!e.target.closest('#dy-menu') && !e.target.closest('.dy-block')) closeMenu();
  return false;
}

function openPushProgressModal(plannedHint) {
  const modal = $('modal');
  const box = $('modalBox');
  const ac = new AbortController();
  const started = Date.now();
  let tick = 0;
  let timer = null;
  let progressNote = '';

  const paint = () => {
    const elapsed = Math.round((Date.now() - started) / 1000);
    const pct = Math.min(90, 12 + tick * 8);
    box.innerHTML = `
      <h2 style="font-size:16px;font-weight:600;margin-bottom:4px">Pushing to Google Calendar</h2>
      <p class="meta">Cursor writer · titles from DB · read-back before applied
        · Elapsed ${elapsed}s${plannedHint ? ` · ~${esc(String(plannedHint))} planned` : ''}
        ${progressNote ? ` · ${esc(progressNote)}` : ''}</p>
      <div class="sched-prog-bar"><div class="sched-prog-fill" style="width:${pct}%"></div></div>
      <ul class="sched-phase-list" style="margin-top:10px">
        <li class="${tick >= 0 ? 'on' : ''}">Build flush plan</li>
        <li class="${tick >= 1 ? 'on' : ''}">Write / patch / delete events (batched)</li>
        <li class="${tick >= 2 ? 'on' : ''}">Read-back verify each write</li>
        <li class="${tick >= 3 ? 'on' : ''}">Refresh rule masters on final batch</li>
      </ul>
      <div style="display:flex;gap:8px;margin-top:14px">
        <button type="button" class="btn-secondary" id="dyPushCancel">Cancel wait</button>
      </div>
      <p class="meta" style="margin-top:8px">Cancel only stops waiting in this browser. Server writes already started may still finish.</p>`;
    const cancel = $('dyPushCancel');
    if (cancel) {
      cancel.onclick = () => {
        ac.abort();
        clearInterval(timer);
        box.innerHTML = `
          <h2 style="font-size:16px;font-weight:600;margin-bottom:8px">Push wait cancelled</h2>
          <p class="meta">Stopped after ${Math.round((Date.now() - started) / 1000)}s. Refresh Diary to see if any writes landed.</p>
          <button type="button" class="btn-verify" id="dyPushClose">Close</button>`;
        $('dyPushClose').onclick = () => modal.classList.remove('open');
      };
    }
  };

  paint();
  modal.classList.add('open');
  timer = setInterval(() => {
    tick += 1;
    paint();
  }, 2000);

  return {
    signal: ac.signal,
    setProgress(note) {
      progressNote = note || '';
      paint();
    },
    finish(res) {
      clearInterval(timer);
      const secs = Math.round((Date.now() - started) / 1000);
      const f = res.flush || {};
      const applied = Number(f.applied || 0);
      const failed = Number(f.failed || 0);
      const planned = Number(f.planned || 0);
      const fails = (f.results || []).filter((r) => !r.ok).slice(0, 8);
      const failHtml = fails.length
        ? `<ul class="sched-sum-notes">${fails.map((r) => `<li class="err">${esc(r.summary || r.event_id || 'write')} — ${esc(r.error || 'failed')}</li>`).join('')}</ul>`
        : '';
      const rm = res.rule_masters;
      const rmLine = rm && !rm.error
        ? `<p class="meta">Rule masters: rest ${esc(String(rm.rest?.desired ?? '—'))}, away ${esc(String(rm.away?.desired ?? '—'))}, fixtures ${esc(String(rm.fixtures?.already_linked_live ?? '—'))}, gaps created ${esc(String(rm.gaps?.created ?? '—'))}</p>`
        : (rm?.error ? `<p class="err">Rule masters: ${esc(rm.error)}</p>` : '');
      const emptyNote = planned === 0 && applied === 0
        ? `<p class="meta" style="margin-top:8px">No diary queue writes this time (schedule already matched Google, or nothing pending). Rule masters still refreshed.</p>`
        : '';
      box.innerHTML = `
        <h2 style="font-size:16px;font-weight:600;margin-bottom:4px">Push complete</h2>
        <p class="meta">Finished in ${secs}s</p>
        <div class="sched-sum-grid" style="margin-top:10px">
          <div><strong>${planned}</strong><span>planned (last batch)</span></div>
          <div><strong>${applied}</strong><span>applied (this run)</span></div>
          <div><strong>${failed}</strong><span>failed</span></div>
        </div>
        ${emptyNote}
        ${rmLine}
        ${failHtml}
        <div style="display:flex;gap:8px;margin-top:14px">
          <button type="button" class="btn-verify" id="dyPushClose">Close</button>
        </div>`;
      $('dyPushClose').onclick = () => modal.classList.remove('open');
    },
    fail(err) {
      clearInterval(timer);
      if (ac.signal.aborted) return;
      const detail = err?.status ? `HTTP ${err.status}` : '';
      const extra = err?.data?.detail
        ? `<p class="meta">${esc(typeof err.data.detail === 'string' ? err.data.detail : JSON.stringify(err.data.detail)).slice(0, 400)}</p>`
        : '';
      box.innerHTML = `
        <h2 style="font-size:16px;font-weight:600;margin-bottom:8px">Push failed</h2>
        <p class="err">${esc(err.message || String(err) || 'Unknown error')}${detail ? ` · ${esc(detail)}` : ''}</p>
        ${extra}
        <p class="meta">If this was a timeout, hit Push again — remaining queue continues in batches of 25.</p>
        <button type="button" class="btn-verify" id="dyPushClose">Close</button>`;
      $('dyPushClose').onclick = () => modal.classList.remove('open');
    },
  };
}

let pushInFlight = false;

async function runPushToGoogleWithModal(btn, refresh) {
  if (pushInFlight) {
    toast('Push already running — wait for the modal to finish');
    return;
  }
  const plannedHint = (btn.textContent.match(/\d+/) || [])[0] || '';
  const label = btn.textContent;
  pushInFlight = true;
  btn.disabled = true;
  btn.textContent = 'Pushing…';
  toast('Push to Google started…');
  const ui = openPushProgressModal(plannedHint);
  let totalApplied = 0;
  let totalFailed = 0;
  let lastRes = null;
  try {
    for (let round = 1; round <= 20; round += 1) {
      if (ui.signal.aborted) break;
      ui.setProgress(`batch ${round}`);
      const res = await api('/api/mc/gcal-auto-sync', {
        method: 'POST',
        body: { action: 'push', limit: 25, force: round === 1 },
        signal: ui.signal,
      });
      lastRes = res;
      const f = res.flush || {};
      totalApplied += Number(f.applied || 0);
      totalFailed += Number(f.failed || 0);
      ui.setProgress(`batch ${round} · ${totalApplied} applied · ${f.remaining_planned || 0} left`);
      if (!f.more) break;
    }
    if (lastRes) {
      lastRes = {
        ...lastRes,
        flush: {
          ...(lastRes.flush || {}),
          applied: totalApplied,
          failed: totalFailed,
          planned: Number(plannedHint) || (lastRes.flush?.planned || 0),
        },
      };
      ui.finish(lastRes);
      toast(`Push done · ${totalApplied} applied · ${totalFailed} failed`);
    }
    await refresh();
  } catch (err) {
    if (ui.signal.aborted) {
      toast('Push wait cancelled');
    } else {
      ui.fail(err);
      toast(err.message || 'Push failed');
    }
  } finally {
    pushInFlight = false;
    btn.disabled = false;
    btn.textContent = label;
  }
}
