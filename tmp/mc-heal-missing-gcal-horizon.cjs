/**
 * Scan diary_pin ghosts (MISSING GCAL) over horizon, then reconcile+flush.
 * node tmp/mc-heal-missing-gcal-horizon.cjs [daysAhead=182]
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { sb } = require('../api/mc/_lib');
const { londonToday, addDaysYmd } = require('../api/mc/diary-lib');
const { getPrimaryEvent } = require('../api/mc/gcal-write-lib');
const { runPinGcalReconcile } = require('../api/mc/pin-gcal-reconcile-lib');
const { pushSync, loadFlags } = require('../api/mc/gcal-auto-sync-lib');

function parsePin(change) {
  const m = String(change || '').match(/^diary_pin:([^|]+)\|([^|]+)/);
  if (!m) return null;
  return { start: m[1].trim(), end: m[2].trim() };
}

async function scanGhosts(from, to) {
  const logs = await sb(
    `recurring_log?select=id,recurring_task_id,ideal_date,scheduled_date,calendar_event_id,change,at`
    + `&scheduled_date=gte.${from}&scheduled_date=lte.${to}&order=at.desc&limit=5000`,
  ) || [];
  const habits = await sb('recurring_tasks?select=id,title,active') || [];
  const habitMap = new Map(habits.map((h) => [h.id, h]));
  const best = new Map();
  for (const log of logs) {
    const pin = parsePin(log.change);
    if (!pin || !log.scheduled_date || !log.recurring_task_id) continue;
    const key = `${log.recurring_task_id}:${log.scheduled_date}`;
    if (best.has(key)) continue;
    best.set(key, { ...log, pin });
  }

  const ghosts = [];
  for (const row of best.values()) {
    const habit = habitMap.get(row.recurring_task_id);
    if (!habit || habit.active === false) continue;
    let missing = false;
    if (!row.calendar_event_id) {
      missing = true;
    } else {
      try {
        const live = await getPrimaryEvent(row.calendar_event_id);
        if (!live || live.status === 'cancelled') missing = true;
      } catch (e) {
        if (e.status === 404 || e.status === 410) missing = true;
        else throw e;
      }
    }
    if (!missing) continue;
    ghosts.push({
      title: habit.title,
      habit_id: habit.id,
      ideal: row.ideal_date,
      scheduled: row.scheduled_date,
      start: row.pin.start,
      end: row.pin.end,
      evt: row.calendar_event_id,
      log_id: row.id,
    });
  }
  return ghosts;
}

(async () => {
  const daysAhead = Number(process.argv[2] || 182);
  const from = londonToday();
  const to = addDaysYmd(from, daysAhead);
  console.log(JSON.stringify({ phase: 'scan', from, to, daysAhead }));

  const before = await scanGhosts(from, to);
  console.log(JSON.stringify({
    phase: 'ghosts_before',
    count: before.length,
    sample: before.slice(0, 40),
  }, null, 2));

  const reconcile = await runPinGcalReconcile(sb, { daysAhead });
  console.log(JSON.stringify({ phase: 'reconcile', reconcile }, null, 2));

  console.log('flags', await loadFlags(sb));
  await sb(`scheduling_rules?key=eq.${encodeURIComponent('gcal_push_inflight_until')}`, {
    method: 'PATCH', prefer: 'return=minimal',
    body: { value: '0', updated_at: new Date().toISOString() },
  }).catch(() => {});

  let applied = 0;
  let failed = 0;
  let planned = 0;
  const failSamples = [];
  for (let i = 0; i < 20; i += 1) {
    const res = await pushSync(sb, 'cursor-heal-missing-gcal', {
      includeBacklog: false,
      includeRuleMasters: false,
      limit: 25,
    });
    const f = res.flush || {};
    planned += Number(f.planned || 0);
    applied += Number(f.applied || 0);
    failed += Number(f.failed || 0);
    for (const r of (f.results || []).filter((x) => !x.ok).slice(0, 5)) {
      failSamples.push({ summary: r.summary, error: r.error });
    }
    console.log(JSON.stringify({
      phase: 'flush_batch',
      i: i + 1,
      planned: f.planned,
      applied: f.applied,
      failed: f.failed,
      more: f.more,
    }));
    if (!f.more && Number(f.planned || 0) === 0) break;
  }

  const after = await scanGhosts(from, to);
  const pending = await sb(
    "gcal_push_queue?status=in.(pending,ready)&select=id,summary,change_kind&order=updated_at.desc&limit=20",
  ) || [];

  console.log(JSON.stringify({
    phase: 'done',
    flush_totals: { planned, applied, failed, failSamples: failSamples.slice(0, 10) },
    ghosts_after: { count: after.length, sample: after.slice(0, 20) },
    still_pending: pending,
  }, null, 2));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
