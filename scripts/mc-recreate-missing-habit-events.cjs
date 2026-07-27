/**
 * Recreate Google events for placed habits missing calendar_event_id.
 * node scripts/mc-recreate-missing-habit-events.cjs
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { sb } = require('../api/mc/_lib');
const { ruleMapFromRows, addDays } = require('../api/mc/scheduling-rules-lib');
const { londonToday } = require('../api/mc/diary-lib');
const { habitGcalTitle } = require('../api/mc/gcal-title-lib');
const { upsertPushRow } = require('../api/mc/gcal-push-lib');
const { pushSync } = require('../api/mc/gcal-auto-sync-lib');

function parsePin(change) {
  const m = String(change || '').match(/^diary_pin:([^|]+)\|(.+)$/);
  if (!m) return null;
  return { startIso: m[1].trim(), endIso: m[2].trim() };
}

async function main() {
  const today = londonToday();
  const to = addDays(today, 180);
  const [rules, habits, logs] = await Promise.all([
    sb('scheduling_rules?select=key,value'),
    sb('recurring_tasks?select=id,title&active=eq.true'),
    sb(`recurring_log?scheduled_date=gte.${today}&scheduled_date=lte.${to}`
      + '&select=id,recurring_task_id,ideal_date,scheduled_date,calendar_event_id,change,at'
      + '&order=at.desc&limit=5000'),
  ]);
  const ruleMap = ruleMapFromRows(rules || []);
  const prefixes = { habit: ruleMap.title_prefix_recurring || 'MC 🔁' };
  const habitMap = new Map((habits || []).map((h) => [h.id, h]));
  const latest = new Map();
  for (const row of logs || []) {
    if (!row.recurring_task_id || !row.scheduled_date) continue;
    if (row.calendar_event_id) continue;
    if (/^skip|^unplaced/i.test(row.change || '')) continue;
    const ideal = row.ideal_date || row.scheduled_date;
    const k = `${row.recurring_task_id}|${ideal}`;
    if (!latest.has(k)) latest.set(k, row);
  }

  await sb(`scheduling_rules?key=eq.${encodeURIComponent('gcal_push_inflight_until')}`, {
    method: 'PATCH', prefer: 'return=minimal',
    body: { value: '0', updated_at: new Date().toISOString() },
  });

  const queued = [];
  for (const row of latest.values()) {
    const pin = parsePin(row.change);
    if (!pin) continue;
    const habit = habitMap.get(row.recurring_task_id);
    if (!habit) continue;
    const title = habitGcalTitle(habit.title, prefixes);
    const ideal = row.ideal_date || row.scheduled_date;
    await upsertPushRow(sb, {
      related_id: `habit_place:${row.recurring_task_id}:${ideal}`,
      entity_type: 'habit',
      change_kind: 'move',
      summary: `Recreate missing GCal: ${habit.title} → ${row.scheduled_date}`,
      proposed_action: [
        `MOVE/CREATE habit "${habit.title}" block to ${pin.startIso} – ${pin.endIso}.`,
        'Create Primary event',
        `ideal_date=${ideal}; scheduled_date=${row.scheduled_date}.`,
      ].join(' '),
      payload: {
        habit_id: row.recurring_task_id,
        title,
        ideal_date: ideal,
        new_start: pin.startIso,
        new_end: pin.endIso,
        calendar_event_id: null,
      },
    });
    queued.push({ title: habit.title, ideal, start: pin.startIso });
  }
  console.log('queued', queued.length);

  const flush = await pushSync(sb, 'cursor-recreate-missing', { includeRuleMasters: false });
  console.log('flush', { planned: flush.flush?.planned, applied: flush.flush?.applied, failed: flush.flush?.failed });

  await sb(`scheduling_rules?key=eq.${encodeURIComponent('gcal_push_inflight_until')}`, {
    method: 'PATCH', prefer: 'return=minimal',
    body: { value: '0', updated_at: new Date().toISOString() },
  });

  const after = await sb(
    `recurring_log?scheduled_date=gte.${today}&scheduled_date=lte.${to}`
    + '&calendar_event_id=is.null&select=id,recurring_task_id,ideal_date,scheduled_date,change'
    + '&order=scheduled_date.asc&limit=100',
  );
  const still = (after || []).filter((r) => r.scheduled_date && !/^skip|^unplaced/i.test(r.change || ''));
  console.log('still_missing', still.length, still.slice(0, 10).map((r) => ({
    ideal: r.ideal_date, day: r.scheduled_date, change: String(r.change || '').slice(0, 40),
  })));
}

main().catch((e) => { console.error(e); process.exit(1); });
