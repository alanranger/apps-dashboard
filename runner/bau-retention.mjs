/**
 * BAU backup retention (Alan 3 Nov, replaces "keep bau_bk_* forever"): a B / H backup bau_bk_<run8>_* is dropped
 *   - 14 days after its live run finished, or
 *   - earlier, once a newer live run of the same stage has succeeded (only the latest backup per stage is kept),
 * but never while that stage is mid-undo (an undo run requested / running) or its run failed and awaits a retry.
 * bau_bk_test* (proof) tables are always dropped. Pure: the runner passes the inventory and the recent runs.
 */
export const UNDO_WINDOW_DAYS = 14;
const DAY = 86400000;
const OK = new Set(['succeeded', 'warned']);
const ACTIVE = new Set(['requested', 'running']);

const run8Of = (id) => String(id || '').replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 8);
const isUndo = (r) => !!r.options?.undo_of;
const stageOf = (r) => (r.stages?.length === 1 ? r.stages[0] : null);

/** When the backup of live run `run` stops being undoable (finished + 14 days), or null while it has not finished. */
export function undoUntil(run, days = UNDO_WINDOW_DAYS) {
  return run?.finished_at ? new Date(Date.parse(run.finished_at) + days * DAY).toISOString() : null;
}

function newerSuccess(run, runs) {
  const t = Date.parse(run.requested_at);
  return runs.find((r) => r.mode === 'live' && !isUndo(r) && OK.has(r.status) && stageOf(r) === stageOf(run) && Date.parse(r.requested_at) > t) || null;
}

/** Why the backup of `run` must stay, or null when the rule allows dropping it. */
function protectedReason(run, runs) {
  const stage = stageOf(run);
  if (runs.some((r) => isUndo(r) && ACTIVE.has(r.status) && (r.options.undo_of === run.id || stageOf(r) === stage))) return 'stage is mid-undo';
  if (ACTIVE.has(run.status)) return 'its run is still in progress';
  return null;
}

/** One decision per backup run: { run8, tables, bytes, action: 'drop'|'keep', reason, until }. */
export function decideBackup(run8, tables, runs, now) {
  const bytes = tables.reduce((n, t) => n + (Number(t.bytes) || 0), 0);
  const base = { run8, tables: tables.map((t) => t.table_name), bytes };
  const run = runs.find((r) => run8Of(r.id) === run8);
  if (!run) return { ...base, action: 'keep', reason: 'its run is not in the recent runs (kept; check by hand)', until: null };
  const guard = protectedReason(run, runs);
  if (guard) return { ...base, action: 'keep', reason: guard, until: null };
  const newer = newerSuccess(run, runs);
  if (newer) return { ...base, action: 'drop', reason: `superseded by live run ${run8Of(newer.id)} of stage ${stageOf(run)}`, until: null };
  if (run.status === 'failed') return { ...base, action: 'keep', reason: 'run failed, awaiting retry', until: null };
  const until = undoUntil(run);
  if (until && Date.parse(until) <= now) return { ...base, action: 'drop', reason: `undo window ended ${until.slice(0, 10)}`, until };
  return { ...base, action: 'keep', reason: `undo window open until ${until?.slice(0, 10) || '?'}`, until };
}

/** inventory: rows of bau_backup_inventory(); runs: recent update_all_runs rows. */
export function retentionPlan(inventory, runs, now = Date.now()) {
  const tests = inventory.filter((t) => t.kind === 'test').map((t) => ({ run8: null, tables: [t.table_name], bytes: Number(t.bytes) || 0, action: 'drop', reason: 'proof table' }));
  const groups = new Map();
  for (const t of inventory.filter((x) => x.kind === 'backup' && /^[0-9a-f]{8}$/.test(x.run8 || ''))) {
    if (!groups.has(t.run8)) groups.set(t.run8, []);
    groups.get(t.run8).push(t);
  }
  return [...tests, ...[...groups].map(([run8, tables]) => decideBackup(run8, tables, runs, now))];
}

/** Drop what the plan says (bau_backup_drop refuses anything that is not a bau_bk_* table). Returns log lines. */
export async function applyRetention(plan, rpc) {
  const lines = [];
  for (const d of plan.filter((x) => x.action === 'drop')) {
    for (const t of d.tables) await rpc('bau_backup_drop', { p_table: t });
    lines.push(`dropped ${d.tables.length} table(s) ${d.run8 ? `bau_bk_${d.run8}_*` : d.tables.join(', ')} (${Math.round(d.bytes / 1048576)} MB): ${d.reason}`);
  }
  return lines;
}
