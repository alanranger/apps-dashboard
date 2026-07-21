import { api } from './api.js';
import { $, esc, fmtDate } from './util.js';

let cache = null;

async function loadScheduling() {
  cache = await api('/api/mc/scheduling');
  return cache;
}

function urgencyClass(u) {
  return u === 'high' ? 'sched-urgent' : '';
}

function copyInstructionBlock(pending) {
  const lines = [
    'DIARY APPLY INSTRUCTIONS (from Mission Control Scheduling tab)',
    'Claude: apply these Google Calendar / diary changes. Apps-dashboard never writes Calendar.',
    '',
  ];
  (pending || []).forEach((p, i) => {
    lines.push(`${i + 1}. [${p.change_type}] ${p.summary}`);
    lines.push(`   Target: ${p.target_date || '—'}`);
    lines.push(`   Action: ${p.proposed_action}`);
    if (p.reason) lines.push(`   Reason: ${p.reason}`);
    lines.push('');
  });
  return lines.join('\n');
}

export async function renderScheduling() {
  const el = $('view-scheduling');
  if (!el) return;
  el.innerHTML = '<div class="card"><p class="meta">Loading scheduling…</p></div>';
  try {
    await loadScheduling();
  } catch (e) {
    el.innerHTML = `<div class="card"><p class="err">Scheduling load failed: ${esc(e.message || e)}</p></div>`;
    return;
  }

  const pending = cache.pending || [];
  const rules = cache.rules || [];
  const drives = cache.drive_times || [];
  const hotels = cache.hotels || [];
  const sources = cache.sources || [];

  const sourceBanner = sources.length
    ? `<div class="sched-sources">${sources.map((s) =>
      `<span class="sched-src sched-src-${esc(s.tone || 'red')}">${esc(s.display || s.label)}</span>`,
    ).join('')}<p class="meta">Source of truth: workshop/lesson CSVs (fresher than calendar feeds). After Squarespace export, copy into <code>apps-dashboard/data/schedule/</code> and deploy.</p></div>`
    : '<div class="sched-sources"><span class="sched-src sched-src-red">Schedule CSVs: not loaded</span></div>';

  const pendingEmpty = pending.length
    ? null
    : `<tr><td colspan="4" class="meta">No pending proposals. Detector always names CSV sources + ages in the run log — never a silent “all clear”.</td></tr>`;

  const pendingRows = pending.length
    ? pending.map((p) => `<tr class="${urgencyClass(p.urgency)}">
        <td><span class="pill">${esc(p.change_type)}</span></td>
        <td>${p.target_date ? fmtDate(p.target_date) : '—'}</td>
        <td><strong>${esc(p.summary)}</strong><div class="meta">${esc(p.proposed_action)}</div></td>
        <td class="rec-actions">
          <button type="button" class="btn-verify" data-sched-apply="${p.id}">Applied</button>
          <button type="button" class="btn-secondary" data-sched-dismiss="${p.id}">Dismiss</button>
        </td>
      </tr>`).join('')
    : pendingEmpty;

  const ruleRows = rules.map((r) => `<tr>
      <td><code>${esc(r.key)}</code></td>
      <td>${esc(r.description || '')}</td>
      <td><input data-rule-key="${esc(r.key)}" value="${esc(r.value)}" /></td>
      <td><button type="button" class="btn-secondary" data-rule-save="${esc(r.key)}">Save</button></td>
    </tr>`).join('');

  const driveRows = drives.map((d) => `<tr>
      <td>${esc(d.venue_name)}</td>
      <td><input type="number" data-drive-home="${d.id}" value="${d.minutes_from_home}" style="width:5rem" /></td>
      <td><input type="number" data-drive-hotel="${d.id}" value="${d.minutes_from_hotel != null ? d.minutes_from_hotel : ''}" style="width:5rem" /></td>
      <td><input data-drive-notes="${d.id}" value="${esc(d.notes || '')}" /></td>
      <td><button type="button" class="btn-secondary" data-drive-save="${d.id}">Save</button></td>
    </tr>`).join('');

  const hotelRows = hotels.map((h) => `<tr>
      <td><strong>${esc(h.workshop_name)}</strong><div class="meta">${esc(h.workshop_dates || '')}</div></td>
      <td>${esc(h.hotel || '—')}</td>
      <td>${esc(h.booking_ref || '—')}</td>
      <td>${esc(h.booked_via || '—')}</td>
      <td>${h.free_cancel_until ? fmtDate(h.free_cancel_until) : '—'}</td>
      <td>${h.reminder_placed ? 'yes' : 'no'}</td>
      <td class="meta">${esc(h.notes || '')}</td>
    </tr>`).join('');

  el.innerHTML = `
    ${sourceBanner}
    <div class="card">
      <div class="rec-head">
        <div>
          <h2><i class="ti ti-calendar-time"></i> Pending diary changes
            ${pending.length ? `<span class="pill">${pending.length}</span>` : ''}</h2>
          <p class="meta">Detector proposes · you or Claude apply. <strong>Zero Calendar writes from cron.</strong></p>
        </div>
        <button type="button" class="btn-verify" id="schedCopyAll" ${pending.length ? '' : 'disabled'}>Copy all as instruction</button>
      </div>
      <div class="rec-table-wrap"><table class="rec-table">
        <thead><tr><th>Type</th><th>Date</th><th>Proposal</th><th></th></tr></thead>
        <tbody>${pendingRows}</tbody>
      </table></div>
    </div>

    <div class="card" style="margin-top:1rem">
      <h2>Scheduling rules</h2>
      <p class="meta">Edits write an audit row. Machine proposes; Alan disposes.</p>
      <div class="rec-table-wrap"><table class="rec-table">
        <thead><tr><th>Key</th><th>Note</th><th>Value</th><th></th></tr></thead>
        <tbody>${ruleRows}</tbody>
      </table></div>
    </div>

    <div class="card" style="margin-top:1rem">
      <h2>Venue drive times</h2>
      <p class="meta">Claude estimates (+15m). Correct here — next detection uses your values.</p>
      <div class="rec-table-wrap"><table class="rec-table">
        <thead><tr><th>Venue</th><th>Min from home</th><th>Min from hotel</th><th>Notes</th><th></th></tr></thead>
        <tbody>${driveRows}</tbody>
      </table></div>
    </div>

    <div class="card" style="margin-top:1rem">
      <h2>Hotel register</h2>
      <p class="meta">Direct-booked venues never appear in booking.com searches. Gower: see MC-42 — Gower workshop reschedule.</p>
      <div class="rec-table-wrap"><table class="rec-table">
        <thead><tr><th>Workshop</th><th>Hotel</th><th>Ref</th><th>Via</th><th>Free cancel</th><th>Reminder</th><th>Notes</th></tr></thead>
        <tbody>${hotelRows}</tbody>
      </table></div>
    </div>`;

  $('schedCopyAll').onclick = async () => {
    const text = copyInstructionBlock(pending);
    try {
      await navigator.clipboard.writeText(text);
      alert('Copied — paste into a Claude session to apply diary writes.');
    } catch (err) {
      prompt('Copy this block:', text);
    }
  };
}

export async function handleSchedulingClick(e, onSave) {
  const apply = e.target.closest('[data-sched-apply]');
  if (apply) {
    await api('/api/mc/scheduling', {
      method: 'PATCH',
      body: { entity: 'pending', id: apply.getAttribute('data-sched-apply'), status: 'applied' },
    });
    if (onSave) await onSave();
    return true;
  }
  const dismiss = e.target.closest('[data-sched-dismiss]');
  if (dismiss) {
    await api('/api/mc/scheduling', {
      method: 'PATCH',
      body: { entity: 'pending', id: dismiss.getAttribute('data-sched-dismiss'), status: 'dismissed' },
    });
    if (onSave) await onSave();
    return true;
  }
  const ruleSave = e.target.closest('[data-rule-save]');
  if (ruleSave) {
    const key = ruleSave.getAttribute('data-rule-save');
    const input = document.querySelector(`[data-rule-key="${CSS.escape(key)}"]`);
    await api('/api/mc/scheduling', {
      method: 'PATCH',
      body: { entity: 'rule', key, value: input?.value },
    });
    if (onSave) await onSave();
    return true;
  }
  const driveSave = e.target.closest('[data-drive-save]');
  if (driveSave) {
    const id = driveSave.getAttribute('data-drive-save');
    const home = document.querySelector(`[data-drive-home="${id}"]`)?.value;
    const hotel = document.querySelector(`[data-drive-hotel="${id}"]`)?.value;
    const notes = document.querySelector(`[data-drive-notes="${id}"]`)?.value;
    await api('/api/mc/scheduling', {
      method: 'PATCH',
      body: {
        entity: 'drive',
        id,
        minutes_from_home: Number(home),
        minutes_from_hotel: hotel === '' ? null : Number(hotel),
        notes,
        verified_by: 'alan',
      },
    });
    if (onSave) await onSave();
    return true;
  }
  return false;
}
