/**
 * Visual conflict day resolver UI (Scheduling tab).
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
    return `<div class="cf-block ${cls}${hl}" style="top:${top}%;height:${h}%" title="${esc(b.title)}">
      <span>${esc(b.title)}</span>
    </div>`;
  }).join('');

  return `
    <div class="cf-day-grid" style="height:420px">
      ${hours.join('')}
      ${bars}
    </div>`;
}

function pairButtons(ex, preview) {
  const a = preview?.pair?.a;
  const b = preview?.pair?.b;
  const labelA = esc(ex.shortA || a?.title || 'Block A');
  const labelB = esc(ex.shortB || b?.title || 'Block B');
  const moveA = a?.movable !== false && (a?.movable || ex.eventIdA);
  const moveB = b?.movable !== false && (b?.movable || ex.eventIdB);
  return `
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

function nonOverlapCard(ex) {
  return `
    <div class="cf-card">
      <div class="cf-card-head">
        <div>
          <span class="pill">${esc(ex.typeLabel)}</span>
          <strong>${ex.date ? fmtDate(ex.date) : '—'}</strong>
        </div>
      </div>
      <p class="cf-clash">${esc(ex.clashing).replace(/\n/g, '<br>')}</p>
      <p class="meta">${esc(ex.why)}</p>
      <div class="cf-actions">
        <button type="button" class="btn-secondary" data-cf-diary="${esc(ex.date || '')}">Open in Diary</button>
        <button type="button" class="btn-secondary" data-sched-dismiss="${ex.id}">Dismiss</button>
      </div>
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

  const body = ex.type === 'overlap'
    ? `
      <div class="cf-layout">
        <div class="cf-side">
          <div class="cf-pair">
            <div class="cf-chip cf-chip-a">A · ${esc(ex.shortA || 'Block A')}</div>
            <div class="cf-chip cf-chip-b">B · ${esc(ex.shortB || 'Block B')}</div>
          </div>
          <p class="meta">${esc(ex.why)}</p>
          ${resolverState.loading ? '<p class="meta">Loading day…</p>' : ''}
          ${resolverState.message ? `<p class="cf-msg">${esc(resolverState.message)}</p>` : ''}
          ${pairButtons(ex, preview)}
        </div>
        <div class="cf-timeline-wrap">
          <div class="cf-day-label">${fmtDate(ex.date)} · live diary day</div>
          ${preview && preview.pending_id === ex.id ? renderTimeline(preview) : '<div class="cf-empty meta">Loading timeline…</div>'}
        </div>
      </div>`
    : nonOverlapCard(ex);

  return `<div class="card sched-exceptions cf-resolver" data-cf-current="${ex.id}">
    <div class="rec-head">
      <div>
        <h2><i class="ti ti-layout-sidebar"></i> Conflict day view
          <span class="pill sched-ex-count">${visible.length}</span></h2>
        <p class="sched-exceptions-banner"><strong>See the clash. Pick which block moves.</strong>
          Moves save to Mission Control DB now; Google waits for Push.
          Far-future rows stay hidden until you widen the filter.</p>
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
  if (!ex || ex.type !== 'overlap') {
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
      // stay on same index — list shrinks
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
