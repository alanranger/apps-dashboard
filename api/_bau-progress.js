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

async function runnerState() {
  return (await sb('update_all_runner_state?id=eq.pc').catch(() => []))[0] || null;
}

module.exports = { stepEstimates, runnerState, median };
