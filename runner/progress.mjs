/**
 * Run progress for the page's progress window (Alan 3 Nov): sub-progress { step, done, total, label }, a heartbeat at
 * least every 10 s and the log lines, all on the run row. Step starts / finishes become log lines through a store
 * wrapper, so the engine is unchanged. Writes never fail a run: a lost progress write is only a missed refresh.
 */
const MAX_LOG = 300;
const iso = () => new Date().toISOString();

export function progressReporter(store, runId, { heartbeatMs = 10000, minGapMs = 1500 } = {}) {
  const log = [];
  let progress = null;
  let lastWrite = 0;
  let timer = null;
  let chain = Promise.resolve();
  const write = (force) => {
    if (!force && Date.now() - lastWrite < minGapMs) return chain;
    lastWrite = Date.now();
    const patch = { heartbeat_at: iso(), progress, log: log.slice(-MAX_LOG) };
    chain = chain.then(() => store.updateRun(runId, patch)).catch(() => {});
    return chain;
  };
  return {
    line: (text) => { log.push({ at: iso(), text }); return write(true); },
    step: (step, label) => { progress = { step, done: 0, total: 0, label, at: iso() }; return write(true); },
    progress: (label, done = 0, total = 0) => { progress = { ...(progress || {}), label, done, total, at: iso() }; return write(false); },
    start: () => { clearInterval(timer); timer = setInterval(() => write(true), heartbeatMs); timer.unref?.(); return write(true); },
    stop: () => { clearInterval(timer); timer = null; return write(true); },
    lines: () => log
  };
}

const seconds = (ms) => (ms == null ? '' : ` (${ms < 60000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60000)} min`})`);

/** store.updateStep, plus a log line and a reset sub-progress when a step starts, and a log line when it finishes. */
export function loggingStore(store, reporter, registry) {
  const names = new Map(registry.map((d) => [d.id, d.name]));
  const pos = new Map(registry.map((d, i) => [d.id, i + 1]));
  const updateStep = async (runId, stepId, patch) => {
    const out = await store.updateStep(runId, stepId, patch);
    const name = names.get(stepId) || stepId;
    if (patch.status === 'running') {
      await reporter.step(stepId, `${name}: starting`);
      await reporter.line(`Step ${pos.get(stepId) || '?'} of ${registry.length}: ${name} — started`);
    } else if (patch.finished_at) {
      await reporter.line(`${name} — ${patch.status}${seconds(patch.duration_ms)}${patch.error ? `: ${String(patch.error).slice(0, 160)}` : ''}`);
    }
    return out;
  };
  return { ...store, updateStep };
}

/** The PC runner's idle check, for the page's queued countdown ("next check in N s"). */
export function recordRunnerCheck(store, { host, liveSwitch, busyRun = null }) {
  return store.query('update_all_runner_state?on_conflict=id', { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal',
    body: { id: 'pc', checked_at: iso(), host, live_switch: liveSwitch, busy_run: busyRun } }).catch(() => null);
}
