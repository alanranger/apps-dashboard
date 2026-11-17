/** Publish-all eligibility (CJS copy of publish-all-plan.mjs for the API). */
const PUBLISH_ALL_STAGES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
const SHARED_STAGES = new Set(['A', 'B', 'C', 'H']);
const STALE_TIP = 'Checks are out of date: run Check all stages first.';

function isCheckAllRun(run) {
  if (!run || run.mode !== 'dry') return false;
  if (!['succeeded', 'warned', 'failed'].includes(run.status)) return false;
  return !run.stages || !run.stages.length;
}

function latestCheckAll(runs = []) {
  return runs.find(isCheckAllRun) || null;
}

function stagePublishable(result, id) {
  if (!result || result.status !== 'ok') return { ok: false, reason: !result ? 'not checked in the last Check all' : `check ${result.status}` };
  if (id !== 'B' && Number(result.removals_unexplained || 0) > 0) {
    return { ok: false, reason: `${result.removals_unexplained} unexplained removal(s)` };
  }
  return { ok: true, reason: null, run_id: result.run_id || null };
}

function liveAfter(live, atMs) {
  if (!live?.finished_at || live.undo_of || !atMs) return false;
  return Date.parse(live.finished_at) > atMs;
}

function repoHeadFor(id, repoHeads = {}) {
  return SHARED_STAGES.has(id) ? repoHeads.shared : repoHeads.schema;
}

function checkAllStale(checkAll, { liveDone = {}, repoHeads = {} } = {}) {
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

/** Commits this Check all's own live publishes already made (same promoted build). */
function ownPublishShas(checkId, runs = []) {
  const shas = [];
  if (!checkId) return shas;
  for (const run of runs) {
    if (run.mode !== 'live' || !['succeeded', 'warned'].includes(run.status)) continue;
    for (const r of Object.values(run.stage_results || {})) {
      if (!r || r.promoted_from !== checkId || !['ok', 'warn'].includes(r.status)) continue;
      if (r.commit) shas.push(r.commit);
      if (r.export_commit) shas.push(r.export_commit);
      if (r.manifest_commit) shas.push(r.manifest_commit);
    }
  }
  return shas;
}

function headIsOwn(head, ownShas) {
  const sha = String(head?.sha || '');
  if (!sha || !ownShas?.length) return false;
  return ownShas.some((s) => {
    const o = String(s || '');
    return o.length >= 7 && (sha === o || sha.startsWith(o) || o.startsWith(sha));
  });
}

/** Per-stage staleness. ownShas are this Check all's own live commits and do not count. */
function stageCheckStale(id, dry, live, repoHeads = {}, ownShas = null) {
  if (!dry?.finished_at || !['ok', 'warn'].includes(dry.status)) return { stale: false, tip: null };
  const at = Date.parse(dry.finished_at);
  if (liveAfter(live, at) && live.promoted_from !== dry.run_id) {
    return { stale: true, tip: STALE_TIP };
  }
  const head = repoHeadFor(id, repoHeads);
  if (head?.committed_at && Date.parse(head.committed_at) > at && !headIsOwn(head, ownShas)) {
    return { stale: true, tip: STALE_TIP };
  }
  return { stale: false, tip: null };
}

function publishAllPlan(checkAll, opts = {}) {
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

module.exports = {
  PUBLISH_ALL_STAGES, SHARED_STAGES, STALE_TIP, isCheckAllRun, latestCheckAll, stagePublishable,
  liveAfter, repoHeadFor, checkAllStale, stageCheckStale, ownPublishShas, publishAllPlan
};
