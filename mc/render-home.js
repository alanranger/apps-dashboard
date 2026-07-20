import { store, projectById } from './store.js';
import { $, esc, fmtDate, empty } from './util.js';

function projectChip(t) {
  const p = projectById(t.project_id);
  if (!p) return '';
  return `<span class="chip"><i class="ti ${esc(p.icon)}"></i> ${esc(p.name)}</span>`;
}

export function renderHome() {
  const verify = store.tasks
    .filter((t) => t.state === 'done_claimed')
    .sort((a, b) => String(b.claimed_at || '').localeCompare(String(a.claimed_at || '')));
  const waiting = store.tasks
    .filter((t) => t.state === 'waiting')
    .sort((a, b) => String(a.due_date || '9999').localeCompare(String(b.due_date || '9999')));
  const soonEnd = Date.now() + 7 * 86400000;
  const next7 = store.tasks
    .filter((t) => t.due_date && new Date(t.due_date).getTime() <= soonEnd && t.state !== 'verified')
    .sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)));

  const verRows = verify.length
    ? verify.map((t) => `
      <div class="row">
        <div>${projectChip(t)}</div>
        <div>
          <div class="mcid">MC-${t.display_id}</div>
          <div>${esc(t.title)}</div>
          <div class="meta">${esc(t.claimed_by || '—')} · ${t.evidence_url ? `<a href="${esc(t.evidence_url)}" target="_blank" rel="noopener">evidence</a>` : 'no evidence'}</div>
        </div>
        <button type="button" class="btn-verify" data-verify="${t.id}" ${store.role !== 'alan' ? 'disabled title="Verify is available on Alan\'s login only"' : ''}>Verify</button>
      </div>`).join('')
    : empty('ti-shield-check', 'Nothing awaiting your verification — enjoy it.');

  const waitRows = waiting.length
    ? waiting.map((t) => `
      <div class="row" data-open="${t.id}" style="cursor:pointer">
        <div>${projectChip(t)}</div>
        <div><div class="mcid">MC-${t.display_id}</div><div>${esc(t.title)}</div>
        <div class="meta">${esc(t.waiting_on || '—')} · ${fmtDate(t.due_date)}</div></div>
        <div></div>
      </div>`).join('')
    : empty('ti-hourglass', 'Nothing waiting on the world right now.');

  const nextRows = next7.length
    ? next7.map((t) => `
      <div class="row" data-open="${t.id}" style="cursor:pointer">
        <div class="meta">${fmtDate(t.due_date)}</div>
        <div><div class="mcid">MC-${t.display_id}</div><div>${esc(t.title)}</div>
        <div class="meta">${esc(t.owner)}${t.recurrence ? ' · <span class="pill">recurring</span>' : ''}</div></div>
        <div></div>
      </div>`).join('')
    : empty('ti-calendar', 'No due dates in the next 7 days.');

  $('view-home').innerHTML = `
    <div class="card"><h2>🛡 Awaiting your verification (${verify.length})</h2>${verRows}</div>
    <div class="card"><h2>⏳ Waiting on the world (${waiting.length})</h2>${waitRows}</div>
    <div class="card"><h2>📅 Next 7 days (${next7.length})</h2>${nextRows}</div>`;
}
