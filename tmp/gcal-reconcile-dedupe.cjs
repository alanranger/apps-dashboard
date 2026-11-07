/**
 * Clean duplicate recurring_log rows that share a scheduled_date / event id,
 * delete superseded GCal events, align winners to DB times.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
for (const line of fs.readFileSync(path.join(root, '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { sb } = require('../api/mc/_lib.js');
const { londonToday, addDaysYmd, mondayOnOrBefore, parseDiaryPin } = require('../api/mc/diary-lib.js');
const { patchPrimaryEvent, deletePrimaryEvent } = require('../api/mc/gcal-write-lib.js');
const { ruleMapFromRows } = require('../api/mc/scheduling-rules-lib.js');

function isSkipped(change) {
  return /^skipped\b/i.test(String(change || ''));
}
function isDone(change) {
  return /^completed\b/i.test(String(change || ''));
}
function score(log) {
  let s = 0;
  if (isDone(log.change)) s += 300;
  if (parseDiaryPin(log.change)) s += 200;
  s += Date.parse(log.at || 0) / 1e12;
  return s;
}

async function main() {
  const from = mondayOnOrBefore(londonToday());
  const to = addDaysYmd(from, 8 * 7 - 1);
  const logs = await sb(
    `recurring_log?select=id,recurring_task_id,ideal_date,scheduled_date,calendar_event_id,change,at`
    + `&scheduled_date=gte.${from}&scheduled_date=lte.${to}&order=scheduled_date.asc`,
  );
  const habits = await sb('recurring_tasks?select=id,title,ideal_time,duration_min&active=eq.true');
  const habitById = new Map((habits || []).map((h) => [h.id, h]));
  const rules = ruleMapFromRows(await sb('scheduling_rules?select=key,value'));
  const prefix = rules.title_prefix_recurring || 'MC 🔁';

  const byKey = new Map();
  for (const log of logs || []) {
    if (!log.scheduled_date || isSkipped(log.change)) continue;
    const key = `${log.recurring_task_id}:${log.scheduled_date}`;
    const arr = byKey.get(key) || [];
    arr.push(log);
    byKey.set(key, arr);
  }

  const actions = [];
  for (const [key, arr] of byKey) {
    if (arr.length < 2) continue;
    arr.sort((a, b) => score(b) - score(a));
    const winner = arr[0];
    for (const loser of arr.slice(1)) {
      if (loser.calendar_event_id
        && loser.calendar_event_id !== winner.calendar_event_id) {
        try {
          await deletePrimaryEvent(loser.calendar_event_id);
          actions.push({ type: 'delete_loser_event', key, event_id: loser.calendar_event_id });
        } catch (e) {
          actions.push({
            type: 'delete_loser_event', key, event_id: loser.calendar_event_id,
            error: e.message,
          });
        }
      }
      await sb(`recurring_log?id=eq.${loser.id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: {
          change: `skipped duplicate_of:${winner.id}`,
          calendar_event_id: null,
          roll_reason: 'reconcile_dedupe',
        },
      });
      actions.push({ type: 'skip_loser_log', key, loser: loser.id, winner: winner.id });
    }
  }

  // Delete GCal "Deconflict …" one-offs (not linked as primary habit blocks)
  const report = JSON.parse(fs.readFileSync(path.join(root, 'tmp/gcal-reconcile-diary-LATEST.json'), 'utf8'));
  for (const o of report.orphan_gcal_mc || []) {
    if (!/Deconflict/i.test(o.summary || '')) continue;
    try {
      await deletePrimaryEvent(o.event_id);
      actions.push({ type: 'delete_deconflict_orphan', event_id: o.event_id, summary: o.summary });
    } catch (e) {
      actions.push({ type: 'delete_deconflict_orphan', event_id: o.event_id, error: e.message });
    }
  }

  // Align remaining winners' GCal times from pins
  const fresh = await sb(
    `recurring_log?select=id,recurring_task_id,scheduled_date,calendar_event_id,change`
    + `&scheduled_date=gte.${from}&scheduled_date=lte.${to}`,
  );
  const best = new Map();
  for (const log of fresh || []) {
    if (isSkipped(log.change) || !log.calendar_event_id) continue;
    const key = `${log.recurring_task_id}:${log.scheduled_date}`;
    const prev = best.get(key);
    if (!prev || score(log) > score(prev)) best.set(key, log);
  }
  for (const log of best.values()) {
    const pin = parseDiaryPin(log.change);
    if (!pin) continue;
    const habit = habitById.get(log.recurring_task_id);
    try {
      await patchPrimaryEvent(log.calendar_event_id, {
        startIso: pin.start,
        endIso: pin.end,
        summary: `${prefix} ${habit?.title || 'habit'}`,
      });
      actions.push({
        type: 'align_pin', event_id: log.calendar_event_id, start: pin.start, end: pin.end,
      });
    } catch (e) {
      actions.push({ type: 'align_pin', event_id: log.calendar_event_id, error: e.message });
    }
  }

  const out = {
    at: new Date().toISOString(),
    action_count: actions.length,
    actions,
  };
  fs.writeFileSync(path.join(root, 'tmp/gcal-reconcile-dedupe-LATEST.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify({
    action_count: actions.length,
    by_type: actions.reduce((a, x) => {
      a[x.type] = (a[x.type] || 0) + 1;
      return a;
    }, {}),
    errors: actions.filter((a) => a.error),
  }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
