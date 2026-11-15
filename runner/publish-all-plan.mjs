/**
 * Publish-all eligibility (Alan 14 Nov): after Check all, only stages that finished OK with
 * 0 unexplained removals may be published. WARN / FAIL / removals are listed, never published silently.
 * Stale guard (Alan 14 Nov night): a Check all older than a later live publish or newer target-repo
 * commit must not unlock Publish all (or per-stage publish of that checked build).
 */
export const PUBLISH_ALL_STAGES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
export const SHARED_STAGES = new Set(['A', 'B', 'C', 'H']);
export const STALE_TIP = 'Checks are out of date: run Check all stages first.';

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

/** True when live finished after `at` (and is not an undo). */
export function liveAfter(live, atMs) {
  if (!live?.finished_at || live.undo_of || !atMs) return false;
  return Date.parse(live.finished_at) > atMs;
}

/** Repo HEAD for a stage (schema vs shared). */
export function repoHeadFor(id, repoHeads = {}) {
  return SHARED_STAGES.has(id) ? repoHeads.shared : repoHeads.schema;
}

/**
 * Check all is stale when any publishable stage went live after it, or a target repo has a commit newer than it.
 * @returns {{ stale: boolean, tip: string|null, detail: string|null }}
 */
export function checkAllStale(checkAll, { liveDone = {}, repoHeads = {} } = {}) {
  if (!checkAll?.finished_at) return { stale: true, tip: STALE_TIP, detail: 'no finished Check all' };
  const at = Date.parse(checkAll.finished_at);
  const results = checkAll.stage_results || {};
  const liveHits = PUBLISH_ALL_STAGES.filter((id) => stagePublishable(results[id], id).ok && liveAfter(liveDone[id], at));
  if (liveHits.length) return { stale: true, tip: STALE_TIP, detail: `live since check: ${liveHits.join(',')}` };
  for (const key of ['schema', 'shared']) {
    const head = repoHeads[key]?.committed_at;
    if (head && Date.parse(head) > at) return { stale: true, tip: STALE_TIP, detail: `${key} repo newer than check` };
  }
  return { stale: false, tip: null, detail: null };
}

/**
 * Per-stage: checked build is older than that stage's last live (and not the same promoted build) or older than repo HEAD.
 * @returns {{ stale: boolean, tip: string|null }}
 */
export function stageCheckStale(id, dry, live, repoHeads = {}) {
  if (!dry?.finished_at || !['ok', 'warn'].includes(dry.status)) return { stale: false, tip: null };
  const at = Date.parse(dry.finished_at);
  if (liveAfter(live, at) && live.promoted_from !== dry.run_id) {
    return { stale: true, tip: STALE_TIP };
  }
  const head = repoHeadFor(id, repoHeads)?.committed_at;
  if (head && Date.parse(head) > at) return { stale: true, tip: STALE_TIP };
  return { stale: false, tip: null };
}

/**
 * Plan for the Publish all button after a Check all.
 * @returns {{ ready: boolean, label: string, tip: string, publish: string[], skip: {id, reason}[], checkAll: object|null, stale?: boolean }}
 */
export function publishAllPlan(checkAll, opts = {}) {
  if (!checkAll) {
    return {
      ready: false, label: 'Publish all', tip: 'Run Check all stages first. Publish all stays off until that check finishes.',
      publish: [], skip: PUBLISH_ALL_STAGES.map((id) => ({ id, reason: 'no Check all yet' })), checkAll: null
    };
  }
  const freshness = checkAllStale(checkAll, opts);
  if (freshness.stale) {
    return {
      ready: false, label: 'Publish all', tip: freshness.tip, stale: true, stale_detail: freshness.detail,
      publish: [], skip: PUBLISH_ALL_STAGES.map((id) => ({ id, reason: 'checks out of date' })), checkAll
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
  const slim = { id: checkAll.id, finished_at: checkAll.finished_at, status: checkAll.status };
  if (!n) {
    return {
      ready: false, label: 'Publish all', tip: 'No stage is checked OK with 0 unexplained removals. Fix the failing stages, then Check all again.',
      publish, skip, checkAll: slim
    };
  }
  if (n === total) {
    return {
      ready: true, label: 'Publish all', tip: `Publishes checked builds for A–H in order from Check all ${String(checkAll.id).slice(0, 8)}. Nothing is rebuilt.`,
      publish, skip, checkAll: slim
    };
  }
  return {
    ready: true,
    label: `Publish all checked-OK stages (${n} of ${total})`,
    tip: `Publishes ${n} checked-OK stage(s); skips ${skip.map((s) => `${s.id} (${s.reason})`).join(', ')}. Each skipped stage keeps its own Fix / Publish live buttons.`,
    publish, skip, checkAll: slim
  };
}
