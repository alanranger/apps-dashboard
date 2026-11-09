/**
 * BAU progress window (Alan 3 Nov): one pop-up for every run — each stage's Build & check / Publish live / Undo, and
 * Run all (test or live). It reads the run the page already polls (run.progress, run.heartbeat_at, run.log written by
 * the PC runner; estimates and runner state from the API) and re-renders every second for the timers.
 * Uses the page's helpers: esc, clock, duration, modeBadge, headline, isUndo, scopeText, stageResultHtml, failureHtml,
 * latestLiveIs, act, openLiveConfirm, openUndoConfirm, undoTip.
 */
(function () {
  const AMBER_MS = 60000;
  const RED_MS = 180000;
  const CHECK_MS = 60000;
  const DONE = new Set(['ok', 'warn', 'skipped', 'fail']);
  const ACTIVE = new Set(['requested', 'running']);
  const ICON = { ok: '✅', warn: '⚠️', fail: '❌', running: '⏳', pending: '⬜', skipped: '✅' };
  const RESULT = { succeeded: ['✅', 'ok'], warned: ['⚠️', 'warn'], failed: ['❌', 'fail'], cancelled: ['❌', 'fail'] };
  const S = { data: null, offset: 0, open: false, timer: null, title: document.title, watched: null, lastStatus: null,
    sound: localStorage.getItem('bau_sound') !== '0', logPinned: true };

  const now = () => Date.now() + S.offset;
  const ms = (iso) => (iso ? Date.parse(iso) : null);
  const ago = (t) => { const s = Math.max(0, Math.round((now() - t) / 1000)); return s < 90 ? `${s} s` : `${Math.round(s / 60)} min`; };

  // ---------- model: steps, weights, %, ETA ----------
  function orderedSteps(data) {
    const defs = new Map((data.registry || []).map((d) => [d.id, d]));
    return [...(data.steps || [])].sort((a, b) => a.ord - b.ord).map((s) => ({ ...s, stage: defs.get(s.step_id)?.stage || null, name: s.name || defs.get(s.step_id)?.name || s.step_id }));
  }

  /** Stage I only starts the full audit and finishes; the audit itself runs in the background, so it adds no time here. */
  const BACKGROUND_STEPS = new Set(['audit']);
  function weights(steps, est) {
    const known = steps.filter((s) => !BACKGROUND_STEPS.has(s.step_id)).map((s) => est?.[s.step_id]).filter((v) => v > 0).sort((a, b) => a - b);
    const fallback = known.length ? known[Math.floor(known.length / 2)] : 60000;
    const w = (s) => {
      if (BACKGROUND_STEPS.has(s.step_id)) return 0;
      return est?.[s.step_id] > 0 ? est[s.step_id] : fallback;
    };
    return { w, anyKnown: known.length > 0 };
  }

  /** "+ full audit ~3 h in the background" next to the estimate when the run includes stage I (a check only simulates it). */
  function auditNote(run, list) {
    if (!run.include_audit || !list.some((s) => BACKGROUND_STEPS.has(s.step_id))) return '';
    return run.mode === 'live' ? ' + full audit ~3 h in the background' : ' + full audit ① (simulated in a check; live it runs ~3 h in the background)';
  }

  /** Fraction of the current step: the runner's sub-progress, else elapsed / typical duration (capped at 95%). */
  function currentFraction(run, cur, est) {
    const p = run.progress;
    if (p && p.step === cur.step_id && p.total > 0) return Math.min(1, p.done / p.total);
    const typical = est?.[cur.step_id];
    const started = ms(cur.started_at);
    return typical > 0 && started ? Math.min(0.95, (now() - started) / typical) : 0;
  }

  function measure(list, run, est) {
    const { w, anyKnown } = weights(list, est);
    const cur = list.find((s) => s.status === 'running') || list.find((s) => s.step_id === run.current_step && !DONE.has(s.status)) || null;
    const frac = cur ? currentFraction(run, cur, est) : 0;
    let done = 0; let total = 0; let left = 0;
    for (const s of list) {
      total += w(s);
      if (DONE.has(s.status)) done += w(s);
      else if (s === cur) { done += w(s) * frac; left += w(s) * (1 - frac); } else left += w(s);
    }
    return { cur, frac, pct: total ? Math.round((done / total) * 100) : 0, leftMs: left, anyKnown, overdue: overdue(run, cur, est) };
  }

  /** Without sub-progress, a step past its usual time has no honest % or ETA: say so instead of "under a minute". */
  function overdue(run, cur, est) {
    if (!cur || (run.progress?.step === cur.step_id && run.progress.total > 0)) return null;
    const typical = est?.[cur.step_id];
    const elapsed = now() - (ms(cur.started_at) || now());
    return typical > 0 && elapsed > typical ? { typical, elapsed } : null;
  }

  function etaText(m) {
    if (m.overdue) return `taking longer than usual (typically ${duration(m.overdue.typical)}, now ${duration(m.overdue.elapsed)}) — no estimate`;
    if (!m.anyKnown) return 'first run, no estimate yet';
    if (m.leftMs < 60000) return 'under a minute left';
    return `about ${Math.round(m.leftMs / 60000)} min left`;
  }

  /** Run all: one row per stage A–I with its tick, and the stage in progress. */
  function stageRows(list, run, est) {
    const ids = [...new Set(list.map((s) => s.stage).filter(Boolean))];
    return ids.map((id) => {
      const mine = list.filter((s) => s.stage === id);
      const st = mine.some((s) => s.status === 'fail') ? 'fail' : mine.some((s) => s.status === 'running') ? 'running'
        : mine.every((s) => DONE.has(s.status)) ? 'ok' : 'pending';
      return { id, status: st, pct: measure(mine, run, est).pct };
    });
  }

  // ---------- alive / stalled ----------
  function lastActivity(run) {
    const logAt = (run.log || []).length ? ms(run.log[run.log.length - 1].at) : null;
    const xs = [ms(run.heartbeat_at), ms(run.progress?.at), logAt].filter(Boolean);
    return xs.length ? Math.max(...xs) : null;
  }

  function aliveHtml(run, list) {
    const t = lastActivity(run);
    if (!t) {
      const changed = list.map((s) => ms(s.finished_at) || ms(s.started_at)).filter(Boolean);
      const at = changed.length ? clock(new Date(Math.max(...changed)).toISOString()) : '-';
      return `<div class="pg-alive pg-grey" data-testid="pg-alive" data-level="unknown">Activity unknown: this run started on a runner without a heartbeat (last step change ${esc(at)}).</div>`;
    }
    const age = now() - t;
    if (age >= RED_MS) {
      return `<div class="pg-alive pg-red" data-testid="pg-alive" data-level="red">❌ Runner seems stopped — no activity for ${ago(t)}.
        <div class="pg-todo">What to do: check Alan's PC is on and awake (the runner task starts every minute). If this stays red, press Cancel and ask Claude before Resume.</div></div>`;
    }
    if (age >= AMBER_MS) return `<div class="pg-alive pg-amber" data-testid="pg-alive" data-level="amber">⚠ No activity for ${ago(t)} — still working?</div>`;
    return `<div class="pg-alive pg-green" data-testid="pg-alive" data-level="ok">● Last activity ${ago(t)} ago</div>`;
  }

  // ---------- log ----------
  /** The runner's log lines; for runs from before the log existed, built from the step start/finish times. */
  function logLines(run, list) {
    if ((run.log || []).length) return run.log;
    const out = [];
    list.forEach((s, i) => {
      if (s.started_at) out.push({ at: s.started_at, text: `Step ${i + 1} of ${list.length}: ${s.name} — started` });
      if (s.finished_at) out.push({ at: s.finished_at, text: `${s.name} — ${s.status}${s.duration_ms != null ? ` (${duration(s.duration_ms)})` : ''}` });
    });
    return out.sort((a, b) => ms(a.at) - ms(b.at));
  }

  function logHtml(lines) {
    const rows = lines.slice(-300).map((l) => `<li><span class="pg-t">${esc(clock(l.at))}</span> ${esc(l.text)}</li>`).join('');
    return `<ul class="pg-log" id="pgLog" data-testid="pg-log">${rows || '<li class="muted">No activity yet.</li>'}</ul>`;
  }

  // ---------- views ----------
  function header(run) {
    const id = run.stages?.length === 1 ? run.stages[0] : null;
    const name = id ? (window.stageInfo?.defs || stageInfoSafe()).find((d) => d.id === id)?.name || '' : 'Run all';
    return `<div class="pg-head"><div>${modeBadge(run)} <strong data-testid="pg-title">${esc(id ? `Stage ${id} — ${name}` : 'Run all')}${isUndo(run) ? ' (undo)' : ''}</strong>
      <span class="muted">· run <code>${esc(run.id.slice(0, 8))}</code></span></div>
      <button class="small secondary" id="pgClose" data-testid="pg-close" data-tip="Closes this window. The run carries on; nothing changes.">Close</button></div>`;
  }
  function stageInfoSafe() { try { return stageInfo?.defs || []; } catch { return []; } }

  function queuedHtml(run, runner) {
    const until = ms(run.cooldown_until);
    const w = run.options?.wait_for_refresh && until > now() ? run.options.refresh_wait : null;
    if (w) return `<p class="pg-big" data-testid="pg-queued">Queued behind the Monday full refresh (step ${esc(w.step)} of ${esc(w.steps)}, about ${esc(clock(w.eta).slice(0, 5))})</p><div class="muted">It starts by itself once the refresh has finished (re-checked every 10 minutes).</div>`;
    if (until && until > now()) return `<p class="pg-big" data-testid="pg-queued">Waiting for the Squarespace cool-down — starts after ${esc(clock(run.cooldown_until))}</p>`;
    const next = ms(runner?.checked_at) ? ms(runner.checked_at) + CHECK_MS : null;
    let line = 'Waiting for the PC runner — it checks every minute';
    if (next && next > now()) line = `Waiting for the PC runner — next check in ${Math.ceil((next - now()) / 1000)} s`;
    else if (next && now() - next > 45000) line = `⚠ The PC runner hasn't checked since ${clock(runner.checked_at)} — is the PC on?`;
    else if (next) line = 'Waiting for the PC runner — any moment now';
    return `<p class="pg-big" data-testid="pg-queued">${esc(line)}</p><div class="muted">Requested ${esc(clock(run.requested_at))}</div>`;
  }

  function barHtml(pct, testid) {
    if (pct == null) return `<div class="pg-bar pg-unknown" data-testid="${testid}" data-pct=""><div></div><span>no % yet — the runner reports no sub-steps for this step</span></div>`;
    return `<div class="pg-bar" data-testid="${testid}" data-pct="${pct}"><div style="width:${pct}%"></div><span>${pct}%</span></div>`;
  }

  function subLine(run, cur) {
    const p = run.progress;
    if (p && p.step === cur?.step_id && p.label) {
      // Runner labels carry {n} (the item in hand, 1-based) and {total}: "Backing up page_html — chunk 9 of 14".
      if (p.label.includes('{n}')) return p.label.replace('{n}', String(Math.min(p.done + 1, p.total))).replace('{total}', String(p.total));
      if (p.label.includes('{done}')) return p.label.replace('{done}', String(p.done)).replace('{total}', String(p.total));
      return p.total > 0 ? `${p.label} — ${p.done} of ${p.total}` : p.label;
    }
    if (cur && !run.heartbeat_at) return 'working… (this run started before the runner reported sub-steps)';
    return cur ? 'working…' : 'starting…';
  }

  function stageListHtml(rows) {
    return `<ul class="pg-stages" data-testid="pg-stages">${rows.map((r) => `<li data-stage="${esc(r.id)}" data-status="${r.status}">${ICON[r.status]} <span class="stage-tag">${esc(r.id)}</span>${r.status === 'running' ? ` ${r.pct}%` : ''}</li>`).join('')}</ul>`;
  }

  function runningHtml(run, list, est) {
    const m = measure(list, run, est);
    const idx = m.cur ? list.indexOf(m.cur) : -1;
    const runAll = !(run.stages?.length);
    const rows = runAll ? stageRows(list, run, est) : [];
    const curStage = m.cur?.stage ? rows.find((r) => r.id === m.cur.stage) : null;
    const overall = runAll ? `<div class="pg-overall" data-testid="pg-overall">Overall: stage ${Math.max(1, rows.findIndex((r) => r.status === 'running') + 1)} of ${rows.length} · ${m.pct}% · ${esc(etaText(m))}<span data-testid="pg-audit-note">${esc(auditNote(run, list))}</span></div>${barHtml(m.pct, 'pg-bar-overall')}` : '';
    const stagePart = curStage ? `<div class="muted">Stage ${esc(curStage.id)}: ${curStage.pct}%</div>${barHtml(curStage.pct, 'pg-bar')}` : (runAll ? '' : barHtml(m.overdue ? null : m.pct, 'pg-bar'));
    return `${overall}<p class="pg-big" data-testid="pg-step">Step ${idx + 1} of ${list.length}: ${esc(m.cur?.name || 'starting')}</p>
      <p data-testid="pg-sub">${esc(subLine(run, m.cur))}</p>${stagePart}
      <div class="pg-meta"><span data-testid="pg-eta">${esc(runAll ? '' : etaText(m))}</span><span>Elapsed ${esc(duration(now() - ms(run.started_at || run.requested_at)))}</span></div>
      ${aliveHtml(run, list)}${runAll ? stageListHtml(rows) : ''}`;
  }

  /** Pre-flight stopped by the running Monday full refresh (its counts say a queue is possible). */
  const refreshBlocked = (run, list) => run.status === 'failed' && list.some((s) => s.step_id === 'preflight' && s.status === 'fail' && s.counts?.monday_refresh?.queue_option);

  function actionButtons(run, list) {
    const id = run.stages?.length === 1 ? run.stages[0] : null;
    const b = [];
    if (refreshBlocked(run, list)) b.push('<button class="small" data-pg-act="queue" data-testid="pg-run-when-finishes" data-tip="Queues this run behind the Monday full refresh. It starts by itself once the refresh has finished.">Run when it finishes</button>');
    if (run.status === 'failed') b.push('<button class="small" data-pg-act="resume" data-testid="pg-resume" data-tip="Carries on this failed run from the step that failed.">Resume</button>');
    if (id && run.mode === 'live' && !isUndo(run) && run.status === 'failed') b.push('<button class="small live" data-pg-act="again" data-testid="pg-again" data-tip="Opens the publish confirmation for this stage again. Nothing happens until you confirm.">Publish live again…</button>');
    if (id && run.mode === 'live' && !isUndo(run) && ['succeeded', 'warned'].includes(run.status) && latestLiveIs(id, run.id)) b.push(`<button class="small undo" data-pg-act="undo" data-testid="pg-undo" data-tip="${esc(undoTip(id))}">Undo last live…</button>`);
    return b.length ? `<div class="pg-actions">${b.join('')}</div>` : '';
  }

  /** Every step of the run's own stage(s) was skipped (e.g. stage I in a check: ① is only simulated). */
  function simulatedOnly(run, list) {
    const own = list.filter((s) => !['preflight', 'summary'].includes(s.step_id));
    return ['succeeded', 'warned'].includes(run.status) && own.length > 0 && own.every((s) => s.status === 'skipped');
  }

  function simulatedHtml(run, list) {
    const why = list.filter((s) => s.status === 'skipped').flatMap((s) => (s.notes || []).map((n) => n.text)).filter(Boolean);
    return `<p class="pg-result pg-sim" data-testid="pg-result" data-status="simulated">⚪ Nothing was run — simulated only</p>
      <div class="note">${esc(why.join(' ') || 'Every step of this stage was skipped in a check.')} Only a <strong>live</strong> run does this stage's real work${run.stages?.includes('I') ? ' (start ① with Start full audit ①…, or it runs on its Monday schedule)' : ''}.</div>
      <div class="muted">Finished ${esc(clock(run.finished_at))}</div>`;
  }

  function finishedHtml(run, list) {
    if (simulatedOnly(run, list)) return simulatedHtml(run, list);
    const [icon, cls] = RESULT[run.status] || ['', ''];
    const took = ms(run.finished_at) && ms(run.started_at) ? duration(ms(run.finished_at) - ms(run.started_at)) : '-';
    const stages = Object.entries(run.stage_results || {}).map(([id, r]) => stageResultHtml(id, r, run)).join('');
    const ticks = !(run.stages?.length) ? stageListHtml(stageRows(list, run, {})) : '';
    return `<p class="pg-result pg-${cls}" data-testid="pg-result" data-status="${esc(run.status)}">${icon} ${esc(headline(run))}</p>
      <div class="muted">Finished ${esc(clock(run.finished_at))} · took ${esc(took)}</div>${ticks}${stages}${failureHtml(run, run.status === 'failed' ? list : [])}${actionButtons(run, list)}`;
  }

  function bodyHtml(data) {
    const run = data.run;
    const list = orderedSteps(data);
    let main;
    if (run.status === 'requested') main = queuedHtml(run, data.runner);
    else if (run.status === 'running') main = runningHtml(run, list, data.estimates || {});
    else main = finishedHtml(run, list);
    const sound = `<label class="pg-sound" data-tip="Plays a sound when the run finishes."><input type="checkbox" id="pgSound" ${S.sound ? 'checked' : ''}> Sound when done</label>`;
    return `${header(run)}${main}<h4>Log</h4>${logHtml(logLines(run, list))}${sound}`;
  }

  // ---------- modal + notifications ----------
  function ensureModal() {
    let el = document.getElementById('pgModal');
    if (el) return el;
    el = document.createElement('div');
    el.className = 'modal-bg';
    el.id = 'pgModal';
    el.hidden = true;
    el.dataset.testid = 'pg-modal';
    el.setAttribute('data-testid', 'pg-modal');
    el.innerHTML = '<div class="modal pg-modal" id="pgBody" role="dialog" aria-modal="true" aria-label="Run progress"></div>';
    document.body.appendChild(el);
    return el;
  }

  function wire(run) {
    document.getElementById('pgClose').onclick = close;
    document.getElementById('pgSound').onchange = (e) => { S.sound = e.target.checked; localStorage.setItem('bau_sound', S.sound ? '1' : '0'); };
    const log = document.getElementById('pgLog');
    log.onscroll = () => { S.logPinned = log.scrollTop + log.clientHeight >= log.scrollHeight - 8; };
    if (S.logPinned) log.scrollTop = log.scrollHeight;
    document.querySelectorAll('[data-pg-act]').forEach((b) => { b.onclick = () => runAction(b.dataset.pgAct, run); });
  }

  function runAction(kind, run) {
    const stage = run.stages?.[0];
    if (kind === 'resume') act({ action: 'resume', run_id: run.id }, 'Resume requested');
    if (kind === 'queue') act({ action: 'resume', run_id: run.id, wait_for_refresh: true }, 'Queued behind the Monday full refresh');
    if (kind === 'again') { close(); openLiveConfirm(stage); }
    if (kind === 'undo') { close(); openUndoConfirm(stage); }
  }

  function render() {
    if (!S.open || !S.data?.run) return;
    const body = document.getElementById('pgBody');
    const keep = document.getElementById('pgLog')?.scrollTop;
    body.innerHTML = bodyHtml(S.data);
    if (!S.logPinned && keep != null) document.getElementById('pgLog').scrollTop = keep;
    wire(S.data.run);
  }

  function beep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination); o.frequency.value = 880; g.gain.value = 0.08;
      o.start(); o.stop(ctx.currentTime + 0.35);
    } catch { /* no audio */ }
  }

  /** Tab title while a run is active, and "✅ B done — BAU" (plus the optional sound) when it finishes. */
  function notify(run) {
    const scope = run.stages?.length === 1 ? run.stages[0] : 'Run all';
    if (ACTIVE.has(run.status)) document.title = `⏳ ${scope} ${run.status === 'requested' ? 'queued' : 'running'} — BAU`;
    else if (S.watched === run.id && ACTIVE.has(S.lastStatus)) {
      const sim = simulatedOnly(run, orderedSteps(S.data || { steps: [] }));
      document.title = sim ? `⚪ ${scope} simulated only — BAU` : `${RESULT[run.status]?.[0] || ''} ${scope} ${run.status === 'failed' ? 'failed' : 'done'} — BAU`;
      if (S.sound) beep();
    }
    S.watched = run.id;
    S.lastStatus = run.status;
  }

  function update(data) {
    if (!data?.run) return;
    S.offset = data.server_now ? Date.parse(data.server_now) - Date.now() : 0;
    const changedRun = S.data?.run?.id !== data.run.id;
    S.data = data;
    notify(data.run);
    if (changedRun && ACTIVE.has(data.run.status) && S.autoOpen) open();
    render();
  }

  function open() {
    ensureModal().hidden = false;
    S.open = true;
    S.logPinned = true;
    render();
    clearInterval(S.timer);
    S.timer = setInterval(render, 1000);
  }

  function close() {
    const el = document.getElementById('pgModal');
    if (el) el.hidden = true;
    S.open = false;
    clearInterval(S.timer);
    if (!ACTIVE.has(S.data?.run?.status)) document.title = S.title;
  }

  /** The stage row while its stage runs: a spinner and its %. */
  function rowHtml(stageId) {
    const run = S.data?.run;
    if (!run || run.status !== 'running') return '';
    const list = orderedSteps(S.data);
    const mine = run.stages?.length ? (run.stages.includes(stageId) ? list : []) : list.filter((s) => s.stage === stageId);
    if (!mine.length || mine.every((s) => DONE.has(s.status)) || !mine.some((s) => s.status === 'running')) return '';
    const m = measure(mine, run, S.data.estimates || {});
    return `<span class="pg-spin" data-testid="pg-row-${esc(stageId)}"></span> ${m.overdue ? 'running' : `${m.pct}%`}`;
  }

  /** Clicks that start a run open the window as soon as the new run shows up. */
  function expect() { S.autoOpen = true; open(); }

  window.BauProgress = { update, open, close, rowHtml, expect, simulatedOnly: (run, steps) => simulatedOnly(run, orderedSteps({ steps, registry: S.data?.registry || [] })),
    _model: { measure, etaText, stageRows, lastActivity, auditNote } };
})();
