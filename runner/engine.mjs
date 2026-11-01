/**
 * Update-all engine: runs the registry steps in order, persists each step, stops at the first hard fail,
 * and resumes from the first step that did not finish ok/warn/skipped.
 * Step results carry levelled notes (info / check / problem): a problem fails the step, a check makes it warn,
 * info never does. After a stage's last step the run's stage_results[stage] is written (stage history).
 */
const DONE = new Set(['ok', 'warn', 'skipped']);
const RANK = { fail: 3, warn: 2, ok: 1, skipped: 0 };
const now = () => new Date().toISOString();

export function firstIncomplete(registry, steps) {
  const byId = new Map(steps.map((s) => [s.step_id, s]));
  const idx = registry.findIndex((def) => !DONE.has(byId.get(def.id)?.status));
  return idx < 0 ? registry.length : idx;
}

/** Legacy warnings (strings) become "check" notes; a step's status follows its worst note. */
export function levelStatus(out) {
  const notes = [...(out.notes || []), ...(out.warnings || []).map((text) => ({ level: 'check', text }))];
  if (out.error && !notes.some((n) => n.level === 'problem')) notes.push({ level: 'problem', text: out.error });
  let status = out.status || 'ok';
  if (notes.some((n) => n.level === 'problem')) status = 'fail';
  else if (status !== 'fail' && notes.some((n) => n.level === 'check')) status = 'warn';
  else if (status === 'warn') status = 'ok';
  return { status, notes };
}

async function runStep(def, handler, ctx) {
  if (ctx.failStep === def.id) return { status: 'fail', notes: [{ level: 'problem', text: `injected failure (test) at ${def.id}`, todo: 'resume the run' }], error: `injected failure (test) at ${def.id}` };
  if (!handler) return { status: 'skipped', notes: [{ level: 'info', text: `no handler for ${def.id}` }] };
  try {
    const out = await handler(ctx);
    const { status, notes } = levelStatus(out);
    return { status, notes, plain: out.plain || null, details: out.details || [], counts: out.counts || {}, outputs: out.outputs || [],
      error: status === 'fail' ? (out.error || notes.find((n) => n.level === 'problem')?.text || null) : null, needsAlan: out.needsAlan || [] };
  } catch (e) {
    const msg = String(e?.message || e).slice(0, 1000);
    return { status: 'fail', notes: [{ level: 'problem', text: msg }], error: msg };
  }
}

/** Stage result once the stage's last step in this run has finished. */
function stageResult(stage, steps, ctx) {
  const mine = steps.filter((s) => s.stage === stage);
  const status = mine.reduce((w, s) => (RANK[s.status] > RANK[w] ? s.status : w), 'skipped');
  const pub = mine.find((s) => s.step_id.startsWith('publish_'))?.counts || {};
  const ingest = mine.find((s) => s.step_id === 'final_ingest')?.counts?.written || null;
  return { status, mode: ctx.mode, finished_at: now(), sandbox: ctx.sandboxRoot || null,
    published: pub.files || [], publish_mode: pub.files ? (ctx.mode === 'live' ? 'published' : 'would publish') : null, commit: pub.commit || null, ingest };
}

async function recordStage(store, run, registry, def, ctx) {
  const stage = def.stage;
  const inRun = !ctx.stages || ctx.stages.includes(stage);
  const last = [...registry].reverse().find((d) => d.stage === stage);
  if (!stage || !inRun || last?.id !== def.id) return;
  const steps = (await store.listSteps(run.id)).map((s) => ({ ...s, stage: registry.find((d) => d.id === s.step_id)?.stage }));
  run.stage_results = { ...(run.stage_results || {}), [stage]: stageResult(stage, steps, ctx) };
  await store.updateRun(run.id, { stage_results: run.stage_results });
}

/** Execute (or resume) one run. Returns the final run status. */
export async function executeRun(store, run, registry, handlers, ctx) {
  await store.insertSteps(registry.map((d) => ({ run_id: run.id, step_id: d.id, ord: d.ord, name: d.name, status: 'pending' })));
  const existing = await store.listSteps(run.id);
  const start = firstIncomplete(registry, existing);
  await store.updateRun(run.id, { status: 'running', started_at: run.started_at || now(), runner_host: ctx.host || null, error: null });
  const needsAlan = [...(run.needs_alan || [])];
  let warned = existing.some((s) => s.status === 'warn');
  for (const def of registry.slice(start)) {
    const attempt = (existing.find((s) => s.step_id === def.id)?.attempt || 0) + 1;
    const t0 = Date.now();
    await store.updateRun(run.id, { current_step: def.id });
    await store.updateStep(run.id, def.id, { status: 'running', started_at: now(), attempt, error: null });
    const r = await runStep(def, handlers[def.id], { ...ctx, runId: run.id, steps: await store.listSteps(run.id) });
    await store.updateStep(run.id, def.id, { status: r.status, finished_at: now(), duration_ms: Date.now() - t0, counts: r.counts || {}, outputs: r.outputs || [],
      warnings: (r.notes || []).filter((n) => n.level === 'check').map((n) => n.text), notes: r.notes || [], plain: r.plain || null, details: r.details || [], error: r.error || null });
    needsAlan.push(...(r.needsAlan || []));
    await recordStage(store, run, registry, def, ctx);
    if (r.status === 'fail' && def.on_fail === 'stop') {
      await store.updateRun(run.id, { status: 'failed', finished_at: now(), error: `${def.name}: ${r.error}`, needs_alan: needsAlan });
      return 'failed';
    }
    warned = warned || r.status === 'warn' || r.status === 'fail';
  }
  const final = warned ? 'warned' : 'succeeded';
  await store.updateRun(run.id, { status: final, finished_at: now(), current_step: null, needs_alan: needsAlan });
  return final;
}
