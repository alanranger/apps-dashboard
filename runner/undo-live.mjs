/**
 * Undo one live stage (the page's "Undo this stage"): an undo run is a live run with options.undo_of = the live run.
 *   files (A, C, D–H): restore exactly that commit's files to their previous versions (same deploy path, own commit, push);
 *   B / H database:    bau_restore(<backup run>) + the refresh RPCs; B's 05 export commit is reversed too;
 *   F:                 the blog baseline commit is reversed (older runs: blogs-manifest.json goes back to the .prev copy).
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { liveDbUndo, refreshAndFinalize } from './db-live.mjs';

const WEB = 'G:/Dropbox/alan ranger photography/Website Code';
const { undoCommit } = await import(pathToFileURL(`${WEB}/Schema Tools/scripts/lib/deploy-schemas.mjs`).href);
export const SHARED = `${WEB}/alan-shared-resources`;
export const SCHEMA_REPO = `${WEB}/Schema Tools/alanranger-schema`;
/** Stages whose files live in alan-shared-resources (busy repo: the clean check is scoped to the stage's files). */
const SHARED_STAGES = new Set(['A', 'B', 'C', 'H']);

function undoFiles(stage, target, runId, repos) {
  if (!target.commit) return null;
  const shared = SHARED_STAGES.has(stage);
  return undoCommit({ repo: shared ? repos.shared : repos.schema, commit: target.commit, filesOnly: shared,
    message: `Undo BAU ${stage} live run ${String(target.run_id).slice(0, 8)} (undo run ${String(runId).slice(0, 8)})` });
}

/** F: reverse the baseline commit (from 4 Nov); older runs kept a .prev copy beside the file instead. */
function restoreManifest(target, runId, repos) {
  if (target.manifest_commit) {
    return undoCommit({ repo: repos.shared, commit: target.manifest_commit, filesOnly: true, message: `Undo BAU F blog baseline (undo run ${String(runId).slice(0, 8)})` });
  }
  const prev = target.manifest_previous;
  if (!prev || !fs.existsSync(prev)) return null;
  fs.copyFileSync(prev, prev.replace(/\.prev-[a-z0-9-]+\.json$/i, '.json'));
  return prev;
}

/** target = the live run's stage_results[stage] (with run_id). deps: { rpc, refreshFn, repos: { shared, schema } }. */
export async function undoStage(stage, target, runId, deps) {
  const repos = deps.repos || { shared: SHARED, schema: SCHEMA_REPO };
  const out = { files: undoFiles(stage, target, runId, repos) };
  if (target.export_commit) out.export = undoCommit({ repo: repos.shared, commit: target.export_commit, filesOnly: true, message: `Undo BAU ${stage} 05 export (undo run ${String(runId).slice(0, 8)})` });
  if (target.backup_run) out.db = await liveDbUndo(target.backup_run, { rpc: deps.rpc, refreshFn: deps.refreshFn || refreshAndFinalize, onProgress: deps.onProgress });
  out.manifest = restoreManifest(target, runId, repos);
  return out;
}

/** Why this undo must not run, or null: only the stage's latest live publish can be undone, once. */
export function undoRefusal(stage, live, undoOf) {
  if (!live || live.run_id !== undoOf) return `the latest live run of stage ${stage} is not ${String(undoOf).slice(0, 8)}`;
  if (live.undo_of) return `stage ${stage}'s latest live run is already an undo`;
  if (!live.commit && !live.backup_run && !live.export_commit) return `stage ${stage}'s live run changed nothing to undo`;
  return null;
}
