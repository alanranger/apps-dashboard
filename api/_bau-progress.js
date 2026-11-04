/**
 * BAU progress window (Alan 3 Nov), API side: per-step time estimates from earlier runs (ETA) and the PC runner's
 * last check (queued countdown). The run row itself carries progress / heartbeat_at / log, written by the runner.
 */
const { sb } = require('./mc/_lib');

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };

/** step_id → typical duration in ms: median of the latest 5 finished runs of that step in the same mode, else the other mode. */
async function stepEstimates(run) {
  if (!run) return {};
  const [rows, runs] = await Promise.all([
    sb(`update_all_steps?select=step_id,run_id,duration_ms&status=in.(ok,warn)&duration_ms=gt.0&run_id=neq.${run.id}&order=finished_at.desc&limit=800`),
    sb('update_all_runs?select=id,mode&order=requested_at.desc&limit=200')]);
  const modeOf = new Map(runs.map((r) => [r.id, r.mode]));
  const by = {};
  for (const r of rows) {
    const key = `${r.step_id}|${modeOf.get(r.run_id) === run.mode ? 'same' : 'other'}`;
    (by[key] ||= []).push(r.duration_ms);
  }
  const out = {};
  for (const id of new Set(rows.map((r) => r.step_id))) {
    const same = (by[`${id}|same`] || []).slice(0, 5);
    out[id] = median(same.length ? same : (by[`${id}|other`] || []).slice(0, 5));
  }
  return out;
}

/** stage → { dry, live } typical run time in ms: median of the last 5 finished single-stage runs (undo runs excluded). */
function stageTypical(runs) {
  const by = {};
  for (const r of runs) {
    const ok = ['succeeded', 'warned'].includes(r.status) && r.stages?.length === 1 && !r.options?.undo_of && r.started_at && r.finished_at;
    if (!ok) continue;
    const key = `${r.stages[0]}|${r.mode}`;
    (by[key] ||= []).push(Date.parse(r.finished_at) - Date.parse(r.started_at));
  }
  const out = {};
  for (const [key, list] of Object.entries(by)) {
    const [stage, mode] = key.split('|');
    (out[stage] ||= {})[mode] = median(list.slice(0, 5));
  }
  return out;
}

/** Stage I's row: the latest full ① run (it runs in the background after live I starts it) and open findings. */
async function latestAudit() {
  const [runs, open] = await Promise.all([
    sb('fault_monitor_runs?source=eq.trad_seo&order=started_at.desc&limit=1&select=id,status,started_at,finished_at,last_tick_at,pages_planned,pages_checked,cursor,error,site_checks_done').catch(() => []),
    sb('fault_monitor_findings?status=eq.open&select=fault_key').catch(() => [])]);
  return runs[0] ? { ...runs[0], findings_open: open.length } : null;
}

async function runnerState() {
  return (await sb('update_all_runner_state?id=eq.pc').catch(() => []))[0] || null;
}

module.exports = { stepEstimates, stageTypical, runnerState, latestAudit, median };
