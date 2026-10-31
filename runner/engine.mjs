/**
 * Update-all engine: runs the registry steps in order, persists each step, stops at the first hard fail,
 * collects warnings, and resumes from the first step that did not finish ok/warn/skipped.
 */
const DONE = new Set(['ok', 'warn', 'skipped']);
const now = () => new Date().toISOString();

export function firstIncomplete(registry, steps) {
  const byId = new Map(steps.map((s) => [s.step_id, s]));
  const idx = registry.findIndex((def) => !DONE.has(byId.get(def.id)?.status));
  return idx < 0 ? registry.length : idx;
}

async function runStep(def, handler, ctx) {
  if (ctx.failStep === def.id) return { status: 'fail', error: `injected failure (test) at ${def.id}` };
  if (!handler) return { status: 'skipped', warnings: [`no handler for ${def.id}`] };
  try {
    const out = await handler(ctx);
    return { status: out.status || 'ok', counts: out.counts || {}, outputs: out.outputs || [], warnings: out.warnings || [], error: out.error || null, needsAlan: out.needsAlan || [] };
  } catch (e) {
    return { status: 'fail', error: String(e?.message || e).slice(0, 1000) };
  }
}

/** Execute (or resume) one run. Returns the final run status. */
export async function executeRun(store, run, registry, handlers, ctx) {
  await store.insertSteps(registry.map((d) => ({ run_id: run.id, step_id: d.id, ord: d.ord, name: d.name, status: 'pending' })));
  const existing = await store.listSteps(run.id);
  const start = firstIncomplete(registry, existing);
  await store.updateRun(run.id, { status: 'running', started_at: run.started_at || now(), runner_host: ctx.host || null, error: null });
  const needsAlan = [...(run.needs_alan || [])];
  let warned = existing.some((s) => s.status === 'warn' || s.status === 'skipped');
  for (const def of registry.slice(start)) {
    const attempt = (existing.find((s) => s.step_id === def.id)?.attempt || 0) + 1;
    const t0 = Date.now();
    await store.updateRun(run.id, { current_step: def.id });
    await store.updateStep(run.id, def.id, { status: 'running', started_at: now(), attempt, error: null });
    const r = await runStep(def, handlers[def.id], { ...ctx, runId: run.id, steps: await store.listSteps(run.id) });
    await store.updateStep(run.id, def.id, { status: r.status, finished_at: now(), duration_ms: Date.now() - t0,
      counts: r.counts || {}, outputs: r.outputs || [], warnings: r.warnings || [], error: r.error || null });
    needsAlan.push(...(r.needsAlan || []));
    if (r.status === 'fail' && def.on_fail === 'stop') {
      await store.updateRun(run.id, { status: 'failed', finished_at: now(), error: `${def.name}: ${r.error}`, needs_alan: needsAlan });
      return 'failed';
    }
    warned = warned || r.status !== 'ok';
  }
  const final = warned ? 'warned' : 'succeeded';
  await store.updateRun(run.id, { status: final, finished_at: now(), current_step: null, needs_alan: needsAlan });
  return final;
}
