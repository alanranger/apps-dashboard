/**
 * Publish-all eligibility (Alan 14 Nov): after Check all, only stages that finished OK with
 * 0 unexplained removals may be published. WARN / FAIL / removals are listed, never published silently.
 */
export const PUBLISH_ALL_STAGES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

/** A finished dry Run-all / Check-all (stages omitted = every stage). */
export function isCheckAllRun(run) {
  if (!run || run.mode !== 'dry') return false;
  if (!['succeeded', 'warned', 'failed'].includes(run.status)) return false;
  return !run.stages || !run.stages.length;
}

/** Latest finished Check all from newest-first runs, or null. */
export function latestCheckAll(runs = []) {
  return runs.find(isCheckAllRun) || null;
}

/** One stage: publishable only when status is exactly ok and removals_unexplained is 0 (or absent on B). */
export function stagePublishable(result, id) {
  if (!result || result.status !== 'ok') return { ok: false, reason: !result ? 'not checked in the last Check all' : `check ${result.status}` };
  if (id !== 'B' && Number(result.removals_unexplained || 0) > 0) {
    return { ok: false, reason: `${result.removals_unexplained} unexplained removal(s)` };
  }
  return { ok: true, reason: null, run_id: result.run_id || null };
}

/**
 * Plan for the Publish all button after a Check all.
 * @returns {{ ready: boolean, label: string, tip: string, publish: string[], skip: {id, reason}[], checkAll: object|null }}
 */
export function publishAllPlan(checkAll) {
  if (!checkAll) {
    return {
      ready: false, label: 'Publish all', tip: 'Run Check all stages first. Publish all stays off until that check finishes.',
      publish: [], skip: PUBLISH_ALL_STAGES.map((id) => ({ id, reason: 'no Check all yet' })), checkAll: null
    };
  }
  const results = checkAll.stage_results || {};
  const publish = [];
  const skip = [];
  for (const id of PUBLISH_ALL_STAGES) {
    const r = stagePublishable(results[id], id);
    if (r.ok) publish.push(id);
    else skip.push({ id, reason: r.reason });
  }
  const n = publish.length;
  const total = PUBLISH_ALL_STAGES.length;
  if (!n) {
    return {
      ready: false, label: 'Publish all', tip: 'No stage is checked OK with 0 unexplained removals. Fix the failing stages, then Check all again.',
      publish, skip, checkAll
    };
  }
  if (n === total) {
    return {
      ready: true, label: 'Publish all', tip: `Publishes checked builds for A–H in order from Check all ${String(checkAll.id).slice(0, 8)}. Nothing is rebuilt.`,
      publish, skip, checkAll
    };
  }
  return {
    ready: true,
    label: `Publish all checked-OK stages (${n} of ${total})`,
    tip: `Publishes ${n} checked-OK stage(s); skips ${skip.map((s) => `${s.id} (${s.reason})`).join(', ')}. Each skipped stage keeps its own Fix / Publish live buttons.`,
    publish, skip, checkAll
  };
}
