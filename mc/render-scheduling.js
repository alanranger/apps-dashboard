import { api } from './api.js';
import { $, esc, fmtDate } from './util.js';
import { buildExceptions, isException } from './exceptions.js';
import {
  buildConflictResolverPanel, ensureConflictPreview, handleConflictResolverClick,
} from './conflict-resolver.js';

let cache = null;

async function loadScheduling() {
  cache = await api('/api/mc/scheduling');
  return cache;
}

function urgencyClass(u) {
  return u === 'high' ? 'sched-urgent' : '';
}

/** Display labels only — DB change_type values stay unchanged. */
function displayChangeType(type) {
  const map = {
    rule_breach: 'Conflict',
    missing_travel_block: 'Travel not placed',
    missing_travel: 'Travel not placed',
    missing_buffer: 'Buffers not placed',
    fixture_block: 'Fixture block',
    fixture_block_retire: 'Fixture retire',
    habit_placement: 'Habit place',
    task_bump: 'Task bump',
    missed_habit: 'Missed habit',
    hotel_deadline: 'Hotel deadline',
    cap_over_target: 'Over target',
  };
  return map[type] || type;
}

/** Soften “Missing …” fault language for future-dated travel/buffer to-dos. */
function displaySummary(p) {
  let s = String(p.summary || '');
  s = s.replace(/^Missing travel in horizon:\s*/i, 'Travel not yet placed: ');
  s = s.replace(/^Missing buffers in horizon:\s*/i, 'Buffers not yet placed: ');
  s = s.replace(/^Missing travel(?: block)?(?:s)?:\s*/i, 'Travel not yet placed: ');
  s = s.replace(/^Missing buffers?:\s*/i, 'Buffers not yet placed: ');
  return s;
}

function fmtRunTime(iso) {
  if (!iso) return 'never';
  try {
    return new Date(iso).toLocaleString('en-GB', {
      timeZone: 'Europe/London', dateStyle: 'medium', timeStyle: 'short',
    });
  } catch (e) {
    return String(iso);
  }
}

function sourcesHealthLine(run) {
  const h = run?.sources_health;
  if (!h) return 'no source data recorded';
  const csv = Array.isArray(h.csv) ? h.csv : [];
  const okCount = csv.filter((s) => s.ok).length;
  const parts = [];
  if (csv.length) parts[parts.length] = `${okCount}/${csv.length} CSV sources ok`;
  if (h.holidays) {
    const tone = h.holidays === 'ok' ? '' : ' sched-src-red';
    parts[parts.length] = `<span class="sched-health${tone}">holidays: ${esc(h.holidays)}</span>`;
  }
  if (h.calendars) {
    // "N calendars ok" is green; short/empty/fail/error/not configured are red.
    const ok = /^\d+ calendars ok$/.test(String(h.calendars).trim());
    const tone = ok ? '' : ' sched-src-red';
    parts[parts.length] = `<span class="sched-health${tone}">calendars: ${esc(h.calendars)}</span>`;
  }
  return parts.join(' · ') || 'no source data recorded';
}

function runReadout(run) {
  const when = run ? `${fmtRunTime(run.ran_at)} · ${esc(run.mode || 'auto')}` : 'never run';
  const covered = run && run.covered_from
    ? `${fmtDate(run.covered_from)} → ${fmtDate(run.covered_to)} · ${run.blocks_adjudicated ?? 0} blocks`
    : '—';
  return `<div class="card sched-runpanel">
    <div class="rec-head">
      <div>
        <h2><i class="ti ti-radar"></i> Diary check</h2>
        <p class="meta">The 06:00 cron and this button run the <strong>same</strong> detector. <strong>Full</strong> also auto-places habits across ~26 weeks in several passes (server can't do it in one shot). Findings go to the pending list — never a direct calendar write.</p>
      </div>
      <div class="sched-run-controls">
        <select id="schedScope" aria-label="Check scope">
          <option value="8w">Next 8 weeks (quick)</option>
          <option value="full">Full habit horizon (~26w placer)</option>
        </select>
        <button type="button" class="btn-verify" id="schedRunCheck">Run check now</button>
      </div>
    </div>
    <div class="sched-readout">
      <div><span class="meta">Last run</span><strong>${when}</strong></div>
      <div><span class="meta">Covered</span><strong>${covered}</strong></div>
      <div><span class="meta">Sources</span><strong>${sourcesHealthLine(run)}</strong></div>
    </div>
  </div>`;
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

  await ensureConflictPreview(pending);

  const sourceBanner = sources.length
    ? `<div class="sched-sources">${sources.map((s) =>
      `<span class="sched-src sched-src-${esc(s.tone || 'red')}">${esc(s.display || s.label)}</span>`,
    ).join('')}<p class="meta">Source of truth: GitHub <code>alanranger/alan-shared-resources</code>, <code>csv/</code> path. Freshness badge = the latest commit touching that file (auto-pushed every ~10 min, but only when the export actually changes — so the date is content-driven, never a copy asserting itself fresh). Amber &gt;7 days, red &gt;14 days. Local dev may override with <code>MC_SCHEDULE_CSV_DIR</code>.</p></div>`
    : '<div class="sched-sources"><span class="sched-src sched-src-red">Schedule CSVs: not loaded</span></div>';

  // Exceptions (overlap/cap/gap/unplaceable) live in Conflict day view — keep this table for concrete proposals only.
  const proposalPending = pending.filter((p) => !isException(p));
  const pendingEmpty = proposalPending.length
    ? null
    : `<tr><td colspan="4" class="meta">No concrete proposals left. Decision clashes are above in Conflict day view.</td></tr>`;

  const pendingRows = proposalPending.length
    ? proposalPending.map((p) => `<tr class="${urgencyClass(p.urgency)}">
        <td><span class="pill">${esc(displayChangeType(p.change_type))}</span></td>
        <td>${p.target_date ? fmtDate(p.target_date) : '—'}</td>
        <td><strong>${esc(displaySummary(p))}</strong><div class="meta">${esc(p.proposed_action)}</div></td>
        <td class="rec-actions">
          <button type="button" class="btn-verify" data-sched-apply="${p.id}">Apply</button>
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

  const statusTone = { cancelled: 'sched-src-red', awaiting_booking: 'sched-src-amber' };
  const statusPill = (s) => {
    const v = s || 'active';
    return `<span class="pill ${statusTone[v] || ''}">${esc(v)}</span>`;
  };
  const hotelRows = hotels.map((h) => `<tr>
      <td><strong>${esc(h.workshop_name)}</strong><div class="meta">${esc(h.workshop_dates || '')}</div></td>
      <td>${esc(h.hotel || '—')}</td>
      <td>${statusPill(h.status)}${h.cancelled_at ? `<div class="meta">${fmtDate(h.cancelled_at)}</div>` : ''}</td>
      <td>${esc(h.booking_ref || '—')}</td>
      <td>${esc(h.booked_via || '—')}</td>
      <td>${h.free_cancel_until ? fmtDate(h.free_cancel_until) : '—'}</td>
      <td>${h.reminder_placed ? 'yes' : 'no'}</td>
      <td class="meta">${esc(h.notes || '')}</td>
    </tr>`).join('');

  const exceptions = buildExceptions(pending);
  const exceptionsPanel = buildConflictResolverPanel(pending);

  el.innerHTML = `
    ${sourceBanner}
    ${runReadout(cache.last_run)}
    ${exceptionsPanel}
    <div class="card">
      <div class="rec-head">
        <div>
          <h2><i class="ti ti-calendar-time"></i> Pending diary changes
            ${proposalPending.length ? `<span class="pill">${proposalPending.length}</span>` : ''}</h2>
          <p class="sched-worklist-banner"><strong>Concrete proposals only</strong> (habit places with a target slot, travel fixes, etc.).
            Overlaps / cap / gap decisions are handled above in <strong>Conflict day view</strong>
            (${exceptions.length} exception${exceptions.length === 1 ? '' : 's'}).
            Press <strong>Apply</strong> to enact each proposal (or Dismiss). Nothing hits Google until Push.</p>
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
        <thead><tr><th>Workshop</th><th>Hotel</th><th>Status</th><th>Ref</th><th>Via</th><th>Free cancel</th><th>Reminder</th><th>Notes</th></tr></thead>
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

  const runBtn = $('schedRunCheck');
  if (runBtn) {
    runBtn.onclick = () => startDiaryCheckWithModal(runBtn);
  }
}

const CHECK_PHASES = [
  'Loading schedule CSVs',
  'Bank holidays',
  'Travel / buffer scan',
  'Missed habits',
  'Hotel deadlines',
  'Calendar fetch + rule breaches',
  'Fixture blocks',
  'Heal overlaps & orphan decompress',
  'Recording run',
];

function phaseListHtml(activeIdx) {
  return CHECK_PHASES.map((label, i) => {
    let cls = '';
    let mark = '·';
    if (i < activeIdx) { cls = 'done'; mark = '✓'; }
    else if (i === activeIdx) { cls = 'active'; mark = '…'; }
    return `<li class="${cls}"><span class="sched-phase-mark">${mark}</span>${esc(label)}</li>`;
  }).join('');
}

function healSummaryHtml(heal) {
  if (!heal) return '';
  if (heal.skipped) {
    return `
    <div class="sched-heal-banner" style="margin:10px 0;padding:10px 12px;border-radius:8px;background:rgba(245,158,11,0.12);border:1px solid rgba(245,158,11,0.35)">
      <p style="margin:0"><strong>Auto-heal skipped</strong> — ${esc(heal.note || 'Run Next 8 weeks to heal overlaps/orphans.')}</p>
    </div>`;
  }
  if (heal.error) {
    return `
    <div class="sched-heal-banner" style="margin:10px 0;padding:10px 12px;border-radius:8px;background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.35)">
      <p style="margin:0"><strong>Auto-heal skipped</strong> — ${esc(heal.error)}. Detect results below still apply.</p>
    </div>`;
  }
  const fixed = heal.overlaps_fixed ?? 0;
  const failed = heal.overlaps_failed ?? 0;
  const orphans = (heal.orphans_queued ?? 0) + (heal.gaps_retired ?? 0);
  const pushN = heal.push_queued ?? 0;
  const remain = heal.remaining_pending ?? 0;
  const left = heal.overlaps_left || 0;
  return `
    <div class="sched-heal-banner" style="margin:10px 0;padding:10px 12px;border-radius:8px;background:rgba(34,197,94,0.12);border:1px solid rgba(34,197,94,0.35)">
      <p style="margin:0 0 4px"><strong>Auto-heal</strong> (DB + push queue — Google not written yet)</p>
      <p class="meta" style="margin:0">
        Moved <strong>${fixed}</strong> lower-priority overlap${fixed === 1 ? '' : 's'}
        · queued <strong>${orphans}</strong> orphan/stale decompress cleanup
        ${failed ? ` · <strong>${failed}</strong> overlap${failed === 1 ? '' : 's'} still need a decision` : ''}
        ${left ? ` · <strong>${left}</strong> more overlap${left === 1 ? '' : 's'} next run` : ''}
        · <strong>${remain}</strong> pending row${remain === 1 ? '' : 's'} left
        · <strong>${pushN}</strong> write${pushN === 1 ? '' : 's'} ready for Diary Push
      </p>
      <p class="meta" style="margin:6px 0 0"><strong>Next:</strong> Open Diary → Push to write Google.</p>
    </div>`;
}

function summaryHtml(run, scope) {
  if (!run) return '<p class="meta">Check finished — no summary payload.</p>';
  const covered = run.covered
    ? `${run.covered.from} → ${run.covered.to} (${run.covered.weeks}w)`
    : '—';
  const sh = run.sources_health || {};
  const csvOk = Array.isArray(sh.csv) ? sh.csv.filter((s) => s.ok).length : 0;
  const csvN = Array.isArray(sh.csv) ? sh.csv.length : 0;
  const notes = (run.notes || [])
    .filter((n) => /fixture_block|rule_breach|missed_habit|gcal:|snapshot_/.test(n))
    .slice(0, 6)
    .map((n) => `<li>${esc(n)}</li>`)
    .join('');
  const placerWins = run.placer_windows || [];
  const placerLine = placerWins.length
    ? placerWins.map((p) => {
      if (p.skipped) return `${p.from}→${p.to}: skipped (${p.reason || '—'})`;
      return `${p.from}→${p.to}: +${p.create || 0} create / ${p.move || 0} move`;
    }).map((t) => `<li>${esc(t)}</li>`).join('')
    : '';
  const scopeLabel = scope === 'full'
    ? `Full habit horizon (~${run.habit_horizon_weeks || 26}w placer)`
    : 'Next 8 weeks';
  return `
    <div class="sched-check-summary">
      ${healSummaryHtml(run.heal)}
      <div class="sched-sum-grid">
        <div><span class="meta">Scope</span><strong>${esc(scopeLabel)}</strong></div>
        <div><span class="meta">Covered</span><strong>${esc(covered)}</strong></div>
        <div><span class="meta">New proposals</span><strong>${run.inserted ?? 0}</strong></div>
        <div><span class="meta">Calendar writes</span><strong>${run.calendar_writes ?? 0}</strong></div>
        <div><span class="meta">CSV</span><strong>${csvOk}/${csvN} ok</strong></div>
        <div><span class="meta">Holidays</span><strong>${esc(sh.holidays || '—')}</strong></div>
        <div><span class="meta">Calendars</span><strong>${esc(sh.calendars || '—')}</strong></div>
        <div><span class="meta">Events in horizon</span><strong>${run.events_in_horizon ?? '—'}</strong></div>
      </div>
      ${placerLine ? `<p class="meta" style="margin:8px 0 4px"><strong>Auto-placer windows</strong></p><ul class="sched-sum-notes">${placerLine}</ul>` : ''}
      ${notes ? `<ul class="sched-sum-notes">${notes}</ul>` : ''}
    </div>`;
}

function addDaysYmdClient(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function openCheckProgressModal(scope) {
  const modal = $('modal');
  const box = $('modalBox');
  const ac = new AbortController();
  let phaseIdx = 0;
  let timer = null;
  let statusExtra = '';
  const started = Date.now();

  const paintRunning = () => {
    const elapsed = Math.round((Date.now() - started) / 1000);
    const pct = Math.min(92, Math.round(((phaseIdx + 1) / CHECK_PHASES.length) * 100));
    const scopeLabel = scope === 'full'
      ? 'Full habit horizon (~26w placer in passes)'
      : 'Next 8 weeks';
    box.innerHTML = `
      <h2 style="font-size:16px;font-weight:600;margin-bottom:4px">Diary check running</h2>
      <p class="meta">Scope: <strong>${esc(scopeLabel)}</strong>
        · Elapsed ${elapsed}s</p>
      ${statusExtra ? `<p class="meta"><strong>${esc(statusExtra)}</strong></p>` : ''}
      <div class="sched-prog-bar"><div class="sched-prog-fill" style="width:${pct}%"></div></div>
      <ul class="sched-phase-list">${phaseListHtml(phaseIdx)}</ul>
      <div style="display:flex;gap:8px;margin-top:14px">
        <button type="button" class="btn-secondary" id="schedCheckCancel">Stop / Cancel</button>
      </div>
      <p class="meta" style="margin-top:8px">Cancel stops waiting in this browser. A request already in flight on the server may still finish.</p>`;
    $('schedCheckCancel').onclick = () => {
      ac.abort();
      clearInterval(timer);
      box.innerHTML = `
        <h2 style="font-size:16px;font-weight:600;margin-bottom:8px">Check cancelled</h2>
        <p class="meta">Stopped after ${Math.round((Date.now() - started) / 1000)}s. Pending list unchanged from this wait.</p>
        <button type="button" class="btn-verify" id="schedCheckClose">Close</button>`;
      $('schedCheckClose').onclick = () => modal.classList.remove('open');
    };
  };

  paintRunning();
  modal.classList.add('open');
  timer = setInterval(() => {
    if (phaseIdx < CHECK_PHASES.length - 1) phaseIdx += 1;
    paintRunning();
  }, 2800);

  return {
    signal: ac.signal,
    setStatus(msg) {
      statusExtra = msg || '';
      paintRunning();
    },
    finish(run) {
      clearInterval(timer);
      const secs = Math.round((Date.now() - started) / 1000);
      const heal = run?.heal;
      const pushN = heal?.push_queued ?? 0;
      box.innerHTML = `
        <h2 style="font-size:16px;font-weight:600;margin-bottom:4px">Diary check + heal complete</h2>
        <p class="meta">Finished in ${secs}s · overlaps/orphans auto-fixed where possible
          ${pushN ? ` · <strong>Open Diary → Push ${pushN} write${pushN === 1 ? '' : 's'}</strong> to update Google` : ''}</p>
        ${summaryHtml(run, scope)}
        <div style="display:flex;gap:8px;margin-top:14px">
          <button type="button" class="btn-verify" id="schedCheckClose">Close</button>
        </div>`;
      $('schedCheckClose').onclick = () => modal.classList.remove('open');
    },
    fail(err) {
      clearInterval(timer);
      if (ac.signal.aborted) return;
      box.innerHTML = `
        <h2 style="font-size:16px;font-weight:600;margin-bottom:8px">Diary check failed</h2>
        <p class="err">${esc(err.message || String(err))}</p>
        <button type="button" class="btn-verify" id="schedCheckClose">Close</button>`;
      $('schedCheckClose').onclick = () => modal.classList.remove('open');
    },
  };
}

async function runFullHorizonWithChunks(ui) {
  ui.setStatus('Pass 1 — detect (travel / overlaps / CSV)…');
  const data = await api('/api/mc/scheduling', {
    method: 'PATCH',
    body: { entity: 'run_check', scope: 'full' },
    signal: ui.signal,
  });
  const run = data.run || data;
  const totalWeeks = Number(run.habit_horizon_weeks || 26);
  const chunk = 8;
  const today = new Date().toISOString().slice(0, 10);
  const placerWindows = [];
  let pass = 2;
  for (let w = 0; w < totalWeeks; w += chunk) {
    const from = addDaysYmdClient(today, w * 7);
    const to = addDaysYmdClient(today, Math.min(w + chunk, totalWeeks) * 7);
    const n = Math.floor(w / chunk) + 1;
    const total = Math.ceil(totalWeeks / chunk);
    ui.setStatus(`Pass ${pass} — auto-placer window ${n}/${total} (${from} → ${to})…`);
    const p = await api('/api/mc/scheduling', {
      method: 'PATCH',
      body: { entity: 'run_placer', from, to },
      signal: ui.signal,
    });
    placerWindows.push(p.placer || { from, to, skipped: true });
    pass += 1;
  }
  ui.setStatus(`Pass ${pass} — auto-heal overlaps / orphans…`);
  const healRes = await api('/api/mc/scheduling', {
    method: 'PATCH',
    body: { entity: 'run_heal' },
    signal: ui.signal,
  });
  return {
    ...run,
    placer_windows: placerWindows,
    heal: healRes.heal || run.heal,
    habit_horizon_weeks: totalWeeks,
  };
}

async function startDiaryCheckWithModal(runBtn) {
  const scope = $('schedScope')?.value === 'full' ? 'full' : '8w';
  const label = runBtn.textContent;
  runBtn.disabled = true;
  runBtn.textContent = 'Running…';
  const ui = openCheckProgressModal(scope);
  try {
    const run = scope === 'full'
      ? await runFullHorizonWithChunks(ui)
      : (await api('/api/mc/scheduling', {
        method: 'PATCH',
        body: { entity: 'run_check', scope },
        signal: ui.signal,
      })).run;
    ui.finish(run || {});
    await renderScheduling();
  } catch (err) {
    if (ui.signal.aborted || err.name === 'AbortError') {
      runBtn.disabled = false;
      runBtn.textContent = label;
      return;
    }
    ui.fail(err);
    runBtn.disabled = false;
    runBtn.textContent = label;
  }
}

export async function handleSchedulingClick(e, onSave) {
  if (await handleConflictResolverClick(e, cache?.pending || [], async () => {
    if (onSave) await onSave();
    else await renderScheduling();
  })) {
    return true;
  }
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
