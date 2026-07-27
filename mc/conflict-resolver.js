/**
 * Visual conflict day resolver UI (Scheduling tab).
 * Every dated clash shows the live diary day + concrete move actions.
 */
import { api } from './api.js';
import { esc, fmtDate } from './util.js';
import {
  buildExceptions, filterExceptionsByHorizon, londonTodayYmd,
} from './exceptions.js';

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

let resolverState = {
  horizon: '4w',
  index: 0,
  preview: null,
  loading: false,
  message: null,
};

export function getResolverState() {
  return resolverState;
}

export function setResolverHorizon(h) {
  resolverState.horizon = h;
  resolverState.index = 0;
  resolverState.preview = null;
}

function minsToTop(min, axis) {
  const span = axis.end_min - axis.start_min;
  return ((min - axis.start_min) / span) * 100;
}

function heightPct(dur, axis) {
  const span = axis.end_min - axis.start_min;
  return (Math.max(dur, 15) / span) * 100;
}

function fmtHm(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function loadMeter(preview) {
  if (!preview?.ok || preview.kind !== 'cap') return '';
  const load = preview.load_min || 0;
  const cap = preview.cap_min || 270;
  const over = preview.over_min || Math.max(0, load - cap);
  const pct = Math.min(100, Math.round((load / Math.max(cap, 1)) * 100));
  const overCls = over > 0 ? ' cf-meter-over' : '';
  return `
    <div class="cf-meter${overCls}">
      <div class="cf-meter-bar"><div class="cf-meter-fill" style="width:${pct}%"></div></div>
      <div class="cf-meter-label">
        <strong>${load}m</strong> used of <strong>${cap}m</strong> hard cap
        ${over > 0 ? `· <span class="cf-over">${over}m over</span>` : '· under cap'}
      </div>
    </div>`;
}

function renderTimeline(preview) {
  if (!preview?.ok) {
    return `<div class="cf-empty meta">${esc(preview?.error || 'Could not load day timeline')}</div>`;
  }
  const axis = preview.axis || { start_min: 420, end_min: 1380 };
  const blocks = preview.blocks || [];
  const hours = [];
  for (let m = axis.start_min; m < axis.end_min; m += 60) {
    hours.push(`<div class="cf-hour" style="top:${minsToTop(m, axis)}%">${fmtHm(m)}</div>`);
  }
  const bars = blocks.map((b) => {
    const top = minsToTop(b.start_min, axis);
    const h = heightPct(b.end_min - b.start_min, axis);
    const hl = b.highlight ? ` cf-hl-${b.highlight}` : ' cf-muted';
    const cls = KIND_CLASS[b.kind] || 'dy-personal';
    const mins = b.duration_min != null ? b.duration_min : (b.end_min - b.start_min);
    return `<div class="cf-block ${cls}${hl}" style="top:${top}%;height:${h}%"
      title="${esc(b.title)} · ${mins}m">
      <span>${esc(b.title)}</span>
      <em>${mins}m</em>
    </div>`;
  }).join('');

  return `
    <div class="cf-day-grid" style="height:420px">
      ${hours.join('')}
      ${bars}
    </div>`;
}

function overlapSide(ex, preview) {
  const a = preview?.pair?.a;
  const b = preview?.pair?.b;
  const labelA = esc(ex.shortA || a?.title || 'Block A');
  const labelB = esc(ex.shortB || b?.title || 'Block B');
  const moveA = a?.movable !== false && (a?.movable || ex.eventIdA);
  const moveB = b?.movable !== false && (b?.movable || ex.eventIdB);
  return `
    <div class="cf-pair">
      <div class="cf-chip cf-chip-a">A · ${labelA}</div>
      <div class="cf-chip cf-chip-b">B · ${labelB}</div>
    </div>
    <p class="meta">${esc(ex.why)}</p>
    <div class="cf-actions">
      <button type="button" class="btn-verify" data-cf-move="lower" data-cf-id="${ex.id}"
        ${!(moveA || moveB) ? 'disabled' : ''}>Move lower priority</button>
      <button type="button" class="btn-secondary" data-cf-move="a" data-cf-id="${ex.id}"
        title="${labelA}" ${a && a.movable === false ? 'disabled' : ''}>Move A · ${labelA}</button>
      <button type="button" class="btn-secondary" data-cf-move="b" data-cf-id="${ex.id}"
        title="${labelB}" ${b && b.movable === false ? 'disabled' : ''}>Move B · ${labelB}</button>
      <button type="button" class="btn-secondary" data-cf-diary="${esc(ex.date || '')}">Open in Diary</button>
      <button type="button" class="btn-secondary" data-sched-dismiss="${ex.id}">Dismiss</button>
    </div>`;
}

function loadBlockList(ex, preview) {
  const rows = (preview?.load_blocks || []).map((b) => {
    const when = `${fmtHm(b.start_min)}–${fmtHm(b.end_min)}`;
    const moveBtn = b.movable
      ? `<button type="button" class="btn-verify" data-cf-block="${esc(b.id)}" data-cf-id="${ex.id}">
           Move off day (${b.duration_min}m)</button>`
      : '<span class="meta">fixed</span>';
    return `<li class="cf-load-row">
      <div>
        <strong>${esc(b.title)}</strong>
        <span class="meta">${when} · ${b.duration_min}m</span>
      </div>
      ${moveBtn}
    </li>`;
  }).join('');

  if (!rows) {
    return `<p class="meta">No movable MC work blocks found on this day yet — open Diary to inspect.</p>`;
  }
  return `
    <p class="meta">Orange blocks count toward the daily cap. Move the longest/lowest-value ones off this day.</p>
    <ul class="cf-load-list">${rows}</ul>
    <div class="cf-actions">
      <button type="button" class="btn-secondary" data-cf-diary="${esc(ex.date || '')}">Open in Diary</button>
      <button type="button" class="btn-secondary" data-sched-dismiss="${ex.id}">Dismiss</button>
    </div>`;
}

function daySide(ex, preview) {
  return `
    <p class="cf-clash">${esc(ex.clashing).replace(/\n/g, '<br>')}</p>
    <p class="meta">${esc(ex.why)}</p>
    ${ex.type === 'cap' ? loadMeter(preview) : ''}
    ${ex.type === 'cap' ? loadBlockList(ex, preview) : `
      <div class="cf-actions">
        <button type="button" class="btn-secondary" data-cf-diary="${esc(ex.date || '')}">Open in Diary</button>
        <button type="button" class="btn-secondary" data-sched-dismiss="${ex.id}">Dismiss</button>
      </div>`}`;
}

function datedBody(ex, preview) {
  const side = ex.type === 'overlap'
    ? overlapSide(ex, preview)
    : daySide(ex, preview);
  const timelineReady = preview && preview.pending_id === ex.id;
  return `
    <div class="cf-layout">
      <div class="cf-side">
        ${resolverState.loading ? '<p class="meta">Loading day…</p>' : ''}
        ${resolverState.message ? `<p class="cf-msg">${esc(resolverState.message)}</p>` : ''}
        ${side}
      </div>
      <div class="cf-timeline-wrap">
        <div class="cf-day-label">${fmtDate(ex.date)} · live diary day
          ${preview?.kind === 'cap' ? ' · orange = counts to cap' : ''}
          ${preview?.kind === 'overlap' ? ' · A/B highlighted' : ''}
        </div>
        ${timelineReady ? renderTimeline(preview) : '<div class="cf-empty meta">Loading timeline…</div>'}
      </div>
    </div>`;
}

function undatedBody(ex) {
  return `
    <p class="cf-clash">${esc(ex.clashing).replace(/\n/g, '<br>')}</p>
    <p class="meta">${esc(ex.why)}</p>
    <div class="cf-actions">
      <button type="button" class="btn-secondary" data-sched-dismiss="${ex.id}">Dismiss</button>
    </div>`;
}

export function buildConflictResolverPanel(pending) {
  const all = buildExceptions(pending);
  const today = londonTodayYmd();
  const { visible, total, horizon, from, to } = filterExceptionsByHorizon(
    all, resolverState.horizon, today,
  );
  if (resolverState.index >= visible.length) resolverState.index = Math.max(0, visible.length - 1);
  const idx = resolverState.index;
  const ex = visible[idx] || null;
  const preview = resolverState.preview;

  const filters = ['4w', '8w', 'all'].map((h) => {
    const on = horizon === h ? ' cf-filter-on' : '';
    const label = h === 'all' ? 'All' : h.toUpperCase();
    return `<button type="button" class="btn-secondary cf-filter${on}" data-cf-horizon="${h}">${label}</button>`;
  }).join('');

  const rangeNote = horizon === 'all'
    ? `${total} total`
    : `${visible.length} of ${total} · ${from} → ${to}`;

  if (!ex) {
    return `<div class="card sched-exceptions cf-resolver">
      <div class="rec-head">
        <div>
          <h2><i class="ti ti-layout-sidebar"></i> Conflict day view
            <span class="pill sched-ex-count">${total}</span></h2>
          <p class="sched-exceptions-banner">No conflicts in this horizon. Widen the filter or run Diary check again.</p>
        </div>
        <div class="cf-filters">${filters}</div>
      </div>
      <p class="meta">${esc(rangeNote)}</p>
    </div>`;
  }

  const body = ex.date ? datedBody(ex, preview) : undatedBody(ex);

  return `<div class="card sched-exceptions cf-resolver" data-cf-current="${ex.id}">
    <div class="rec-head">
      <div>
        <h2><i class="ti ti-layout-sidebar"></i> Conflict day view
          <span class="pill sched-ex-count">${visible.length}</span></h2>
        <p class="sched-exceptions-banner"><strong>See the day. Pick what moves.</strong>
          Cap days show which blocks eat the budget. Moves save to Mission Control now; Google waits for Push.</p>
      </div>
      <div class="cf-filters">${filters}</div>
    </div>
    <div class="cf-nav">
      <button type="button" class="btn-secondary" data-cf-prev ${idx <= 0 ? 'disabled' : ''}>← Prev</button>
      <span class="meta">${idx + 1} / ${visible.length} · ${esc(rangeNote)}</span>
      <button type="button" class="btn-secondary" data-cf-next ${idx >= visible.length - 1 ? 'disabled' : ''}>Next →</button>
    </div>
    <div class="cf-card">
      <div class="cf-card-head">
        <span class="pill">${esc(ex.typeLabel)}</span>
        <strong>${ex.date ? fmtDate(ex.date) : '—'}</strong>
      </div>
      ${body}
    </div>
  </div>`;
}

export async function ensureConflictPreview(pending) {
  const all = buildExceptions(pending);
  const { visible } = filterExceptionsByHorizon(all, resolverState.horizon, londonTodayYmd());
  const ex = visible[resolverState.index];
  if (!ex?.date) {
    resolverState.preview = null;
    return;
  }
  if (resolverState.preview?.pending_id === ex.id && resolverState.preview?.ok) return;
  resolverState.loading = true;
  try {
    const data = await api('/api/mc/scheduling', {
      method: 'PATCH',
      body: { entity: 'conflict_preview', id: ex.id },
    });
    resolverState.preview = data.preview || null;
  } catch (e) {
    resolverState.preview = { ok: false, error: e.message || 'preview failed', pending_id: ex.id };
  } finally {
    resolverState.loading = false;
  }
}

export async function handleConflictResolverClick(e, pending, refresh) {
  const horizonBtn = e.target.closest('[data-cf-horizon]');
  if (horizonBtn) {
    setResolverHorizon(horizonBtn.getAttribute('data-cf-horizon'));
    await refresh();
    return true;
  }
  const prev = e.target.closest('[data-cf-prev]');
  if (prev) {
    resolverState.index = Math.max(0, resolverState.index - 1);
    resolverState.preview = null;
    resolverState.message = null;
    await refresh();
    return true;
  }
  const next = e.target.closest('[data-cf-next]');
  if (next) {
    resolverState.index += 1;
    resolverState.preview = null;
    resolverState.message = null;
    await refresh();
    return true;
  }
  const diary = e.target.closest('[data-cf-diary]');
  if (diary) {
    const day = diary.getAttribute('data-cf-diary');
    if (day) sessionStorage.setItem('mc_jump_day', day);
    document.querySelector('.view-btn[data-view="diary"]')?.click();
    return true;
  }
  const blockMove = e.target.closest('[data-cf-block]');
  if (blockMove) {
    const id = blockMove.getAttribute('data-cf-id');
    const blockId = blockMove.getAttribute('data-cf-block');
    blockMove.disabled = true;
    resolverState.message = 'Moving off day…';
    try {
      const data = await api('/api/mc/scheduling', {
        method: 'PATCH',
        body: { entity: 'resolve_block', id, block_id: blockId },
      });
      const r = data.result || {};
      const when = `${String(r.start || '').slice(11, 16)}–${String(r.end || '').slice(11, 16)}`;
      if (r.still_over) {
        resolverState.message = `Moved to ${r.day || ''} ${when}. Still ${r.over_min}m over — move another.`;
      } else {
        resolverState.message = `Moved to ${r.day || ''} ${when} (DB). Day now under cap.`;
      }
      resolverState.preview = null;
      await refresh();
    } catch (err) {
      resolverState.message = err.message || 'Move failed';
      blockMove.disabled = false;
      await refresh();
    }
    return true;
  }
  const move = e.target.closest('[data-cf-move]');
  if (move) {
    const id = move.getAttribute('data-cf-id');
    const which = move.getAttribute('data-cf-move');
    move.disabled = true;
    resolverState.message = 'Moving…';
    try {
      const data = await api('/api/mc/scheduling', {
        method: 'PATCH',
        body: { entity: 'resolve_overlap', id, which },
      });
      const r = data.result || {};
      resolverState.message = `Moved to ${r.day || ''} ${String(r.start || '').slice(11, 16)}–${String(r.end || '').slice(11, 16)} (DB). Push later for Google.`;
      resolverState.preview = null;
      await refresh();
    } catch (err) {
      resolverState.message = err.message || 'Move failed';
      move.disabled = false;
      await refresh();
    }
    return true;
  }
  return false;
}
