/**
 * The AI GEO Audit Monday full refresh (api/cron/ceo-weekly-full-refresh.js, every 2 min on Monday UTC) as the BAU
 * pre-flight sees it: its real run state from system_maintenance_state (key ceo_monday_full_refresh), not the day.
 * Each cron tick saves that row (updated_at) at least once, so a running row with no save for STALL_MS is stuck.
 */
export const REFRESH_KEY = 'ceo_monday_full_refresh';
/** Steps in AI GEO Audit lib/ceo-weekly/dashboard-full-catalog.js buildDashboardFullSteps (29 on 9 Nov 2026). */
export const REFRESH_STEPS = 29;
/** Minutes after the start at which each step finished on 9 Nov 2026 (the ETA table; step 17 is the ~3 h render). */
export const TYPICAL_DONE_MIN = [0, 5, 10, 10, 12, 14, 14, 14, 14, 16, 53, 55, 56, 58, 58, 60, 234, 301, 302, 302, 305, 307, 308, 310, 312, 314, 316, 316, 319];
export const STALL_MS = 30 * 60 * 1000;
export const MAX_RUN_MS = 10 * 3600 * 1000;
export const RECHECK_MS = 10 * 60 * 1000;
const MIN_ETA_MIN = 5;
const DAY_MS = 24 * 3600 * 1000;

const ROW_QUERY = `system_maintenance_state?key=eq.${REFRESH_KEY}&select=state,started_at,finished_at,updated_at,week_start:last_details->>week_start,step_index:last_details->step_index`;

/** The refresh row (null when it has never run). Throws when the database can't be read. */
export async function readRefresh(store) {
  if (!store?.query) return null;
  const rows = await store.query(ROW_QUERY);
  return rows?.[0] || null;
}

const isMondayUtc = (nowMs) => new Date(nowMs).getUTCDay() === 1;
/** This week's Monday 00:00 UTC. */
export function mondayStartUtc(nowMs) {
  const d = new Date(nowMs);
  const sinceMonday = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - sinceMonday * DAY_MS;
}

/**
 * When the refresh should finish: its typical end (start + typical total), or later when it is behind (the steps
 * after the one in hand still to run), and never less than 5 min away.
 */
export function refreshEta(stepIndex, startedMs, nowMs) {
  const i = Math.min(Math.max(Number(stepIndex) || 0, 0), REFRESH_STEPS - 1);
  const total = TYPICAL_DONE_MIN[REFRESH_STEPS - 1] * 60000;
  const afterCurrent = total - TYPICAL_DONE_MIN[i] * 60000;
  const typicalEnd = Number.isFinite(startedMs) ? startedMs + total : 0;
  return new Date(Math.max(typicalEnd, nowMs + afterCurrent, nowMs + MIN_ETA_MIN * 60000)).toISOString();
}

function runningState(row, base, nowMs) {
  const lastSave = Date.parse(row.updated_at || row.started_at || 0);
  const stalled = nowMs - lastSave > STALL_MS;
  const tooLong = nowMs - Date.parse(row.started_at || 0) > MAX_RUN_MS;
  if (stalled || tooLong) return { ...base, state: 'stuck', last_progress_at: row.updated_at || null, reason: stalled ? 'no progress' : 'running too long' };
  return { ...base, state: 'running', eta: refreshEta(row.step_index, Date.parse(row.started_at), nowMs) };
}

/** The cron's last save; a later finished_at comes from a one-off brief resend touching the row (9 Nov: 18:29 vs 05:18). */
function finishedAt(row) {
  const t = [row.finished_at, row.updated_at].filter(Boolean).sort((a, b) => Date.parse(a) - Date.parse(b));
  return t[0] || null;
}

/**
 * running (block) | stuck (say so, with its run id and start) | finished (this Monday) | not_started (Monday, not yet
 * begun) | idle (another day) | none (never ran).
 */
export function refreshState(row, nowMs = Date.now()) {
  if (!row) return { state: 'none' };
  const steps = REFRESH_STEPS;
  const index = Math.max(0, Number(row.step_index) || 0);
  const base = { run_id: `${REFRESH_KEY}/${row.week_start || '?'}`, week_start: row.week_start || null, started_at: row.started_at || null,
    finished_at: row.state === 'running' ? null : finishedAt(row), step: Math.min(index + 1, steps), steps_done: index, steps };
  if (row.state === 'running') return runningState(row, base, nowMs);
  if (!isMondayUtc(nowMs)) return { ...base, state: 'idle' };
  const thisMonday = Date.parse(row.started_at || 0) >= mondayStartUtc(nowMs);
  return { ...base, state: thisMonday ? 'finished' : 'not_started' };
}

/** "05:20" in UK time. */
export const ukClock = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' }) : '?');

export const QUEUE_TODO = 'press Run when it finishes to queue this run behind it (it starts by itself once the refresh is done)';

/** The pre-flight note for a refresh state, or null when there is nothing to say. Level: 'block' | 'warn' | 'info'. */
export function refreshNote(st, nowMs = Date.now()) {
  if (st.state === 'running') {
    return { level: 'block', text: `The Monday full refresh is running (started ${ukClock(st.started_at)}, step ${st.step} of ${st.steps}). Try again after it finishes, about ${ukClock(st.eta)}.`, todo: `${QUEUE_TODO}, or try again after about ${ukClock(st.eta)}` };
  }
  if (st.state === 'stuck') {
    const since = st.last_progress_at ? `, no progress since ${ukClock(st.last_progress_at)}` : '';
    const text = `The Monday full refresh looks stuck: run ${st.run_id} started ${ukClock(st.started_at)}, at step ${st.step} of ${st.steps}${since}.`;
    // The cron only ticks on Mondays: on another day a stuck row can't write, so it is a warning, not a block.
    if (!isMondayUtc(nowMs)) return { level: 'warn', text, todo: 'nothing writes on a non-Monday; ask Claude to clear the stuck row in the AI GEO audit app' };
    return { level: 'block', text, todo: 'ask Claude to check it in the AI GEO audit app (cancel it there if it has stopped), then press Resume' };
  }
  if (st.state === 'finished') return { level: 'info', text: `The Monday full refresh finished at ${ukClock(st.finished_at)} (step ${st.steps_done} of ${st.steps}), so this run can go ahead.` };
  if (st.state === 'not_started') return { level: 'info', text: "This week's Monday full refresh hasn't started yet, so this run can go ahead." };
  return null;
}

const COUNT_KEYS = ['state', 'run_id', 'started_at', 'finished_at', 'last_progress_at', 'step', 'steps', 'eta'];
const pickCounts = (st) => Object.fromEntries(COUNT_KEYS.filter((k) => st[k] != null).map((k) => [k, st[k]]));

/** Pre-flight: { counts, note } with the note levelled for the run mode (a block is a problem live, a check in a dry run). */
export async function refreshPreflight(store, mode, nowMs = Date.now()) {
  let row;
  try {
    row = await readRefresh(store);
  } catch (e) {
    const text = `Couldn't read the Monday full refresh state: ${String(e?.message || e).slice(0, 200)}`;
    return { counts: { state: 'unknown' }, note: { level: mode === 'dry' ? 'check' : 'problem', text, todo: 'press Resume in a minute' } };
  }
  const st = refreshState(row, nowMs);
  const n = refreshNote(st, nowMs);
  const counts = { ...pickCounts(st), queue_option: st.state === 'running' };
  if (!n) return { counts, note: null };
  const level = { block: mode === 'dry' ? 'check' : 'problem', warn: 'check', info: 'info' }[n.level];
  return { counts, note: n.todo ? { level, text: n.text, todo: n.todo } : { level, text: n.text } };
}
