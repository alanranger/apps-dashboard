import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshPreflight, refreshState, refreshEta, mondayStartUtc, REFRESH_STEPS } from '../../runner/monday-refresh.mjs';
import { refreshWait } from '../../runner/update-all-runner.mjs';

const MON = (hhmm) => Date.parse(`2026-11-09T${hhmm}:00Z`);
const TUE = (hhmm) => Date.parse(`2026-11-10T${hhmm}:00Z`);
const store = (row) => ({ query: async (q) => { assert.match(q, /^system_maintenance_state\?key=eq\.ceo_monday_full_refresh/); return row ? [row] : []; } });
const failing = { query: async () => { throw new Error('supabase GET -> 503'); } };

/** 9 Nov 2026 as read from system_maintenance_state at 19:10 UTC (29 of 29 steps, email sent 05:18). */
const FINISHED_9_NOV = { state: 'done', started_at: '2026-11-09T00:00:02.619Z', finished_at: '2026-11-09T18:29:28.696Z', updated_at: '2026-11-09T05:18:42.567Z', week_start: '2026-11-09', step_index: 29 };
const RUNNING = { state: 'running', started_at: '2026-11-09T00:00:02Z', finished_at: null, updated_at: '2026-11-09T01:59:00Z', week_start: '2026-11-09', step_index: 16 };
const LAST_WEEK = { state: 'done', started_at: '2026-11-02T00:00:04Z', finished_at: '2026-11-02T14:42:49Z', updated_at: '2026-11-02T14:42:49Z', week_start: '2026-11-02', step_index: 26 };

test('Monday after the refresh has completed: live pre-flight passes (info note only)', async () => {
  const r = await refreshPreflight(store(FINISHED_9_NOV), 'live', MON('19:04'));
  assert.equal(r.counts.state, 'finished');
  assert.equal(r.counts.queue_option, false);
  assert.equal(r.note.level, 'info');
  assert.match(r.note.text, /finished at 05:18 \(step 29 of 29\), so this run can go ahead/);
});

test('while it is running: live is blocked with start, step, ETA and the queue option (dry only warns)', async () => {
  const live = await refreshPreflight(store(RUNNING), 'live', MON('02:00'));
  assert.equal(live.note.level, 'problem');
  assert.equal(live.note.text, 'The Monday full refresh is running (started 00:00, step 17 of 29). Try again after it finishes, about 05:19.');
  assert.match(live.note.todo, /Run when it finishes/);
  assert.doesNotMatch(`${live.note.text} ${live.note.todo}`, /another day/);
  assert.equal(live.counts.queue_option, true);
  assert.equal(live.counts.step, 17);
  assert.equal(live.counts.eta, '2026-11-09T05:19:02.000Z');
  const dry = await refreshPreflight(store(RUNNING), 'dry', MON('02:00'));
  assert.equal(dry.note.level, 'check');
});

test('a stuck refresh (no progress for 30+ min) is named with its run id and start, not a silent block', async () => {
  const stuck = { ...RUNNING, updated_at: '2026-11-09T01:00:00Z' };
  const mon = await refreshPreflight(store(stuck), 'live', MON('02:00'));
  assert.equal(mon.counts.state, 'stuck');
  assert.equal(mon.counts.queue_option, false);
  assert.equal(mon.note.level, 'problem');
  assert.equal(mon.note.text, 'The Monday full refresh looks stuck: run ceo_monday_full_refresh/2026-11-09 started 00:00, at step 17 of 29, no progress since 01:00.');
  // The cron only ticks on Mondays: left "running" into Tuesday it can't write, so it only warns.
  const tue = await refreshPreflight(store(stuck), 'live', TUE('09:00'));
  assert.equal(tue.note.level, 'check');
  assert.match(tue.note.text, /looks stuck/);
});

test('running longer than the normal maximum (10 h) counts as stuck even with recent saves', () => {
  const st = refreshState({ ...RUNNING, updated_at: '2026-11-09T11:59:00Z' }, MON('12:00'));
  assert.equal(st.state, 'stuck');
  assert.equal(st.reason, 'running too long');
});

test('Monday, not started yet (last week\'s row): pre-flight passes', async () => {
  const r = await refreshPreflight(store(LAST_WEEK), 'live', MON('00:01'));
  assert.equal(r.counts.state, 'not_started');
  assert.equal(r.note.level, 'info');
});

test('another day with a finished refresh, or no row at all: nothing to say', async () => {
  assert.equal((await refreshPreflight(store(FINISHED_9_NOV), 'live', TUE('10:00'))).note, null);
  assert.equal((await refreshPreflight(store(null), 'live', MON('10:00'))).note, null);
  assert.equal((await refreshPreflight(undefined, 'live', MON('10:00'))).counts.state, 'none');
});

test('the refresh state cannot be read: live stops (two writers stay impossible), dry warns', async () => {
  assert.equal((await refreshPreflight(failing, 'live', MON('02:00'))).note.level, 'problem');
  assert.equal((await refreshPreflight(failing, 'dry', MON('02:00'))).note.level, 'check');
});

test('ETA: typical end when on time, later when behind, never under 5 minutes away', () => {
  const start = MON('00:00');
  assert.equal(refreshEta(16, start, MON('02:00')), '2026-11-09T05:19:00.000Z');
  assert.equal(refreshEta(17, start, MON('06:00')), '2026-11-09T06:18:00.000Z');
  assert.equal(refreshEta(REFRESH_STEPS - 1, start, MON('07:00')), '2026-11-09T07:05:00.000Z');
  assert.equal(new Date(mondayStartUtc(Date.parse('2026-11-15T23:00:00Z'))).toISOString(), '2026-11-09T00:00:00.000Z');
});

function memRun(options) {
  const run = { id: 'run-q', mode: 'live', status: 'requested', options };
  return { run, store: { ...store(RUNNING), updateRun: async (id, patch) => Object.assign(run, patch) } };
}

test('Run when it finishes: held (requested, re-checked in 10 min) while the refresh runs', async () => {
  const { run, store: s } = memRun({ wait_for_refresh: true });
  assert.match(await refreshWait(s, run, MON('02:00')), /queued behind the Monday full refresh \(step 17 of 29, about 05:19\)/);
  assert.equal(run.status, 'requested');
  assert.equal(run.cooldown_until, '2026-11-09T02:10:00.000Z');
  assert.deepEqual(run.options.refresh_wait, { started_at: RUNNING.started_at, step: 17, steps: 29, eta: '2026-11-09T05:19:02.000Z' });
});

test('Run when it finishes: goes ahead once the refresh has finished; ordinary runs are never held', async () => {
  const { run } = memRun({ wait_for_refresh: true });
  const finished = { ...store(FINISHED_9_NOV), updateRun: async () => assert.fail('must not park') };
  assert.equal(await refreshWait(finished, run, MON('19:10')), null);
  const plain = memRun({});
  assert.equal(await refreshWait(plain.store, plain.run, MON('02:00')), null);
});
